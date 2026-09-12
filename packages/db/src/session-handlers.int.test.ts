import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDocumentRegisterHandler } from "../../../apps/web/src/document-register.js";
import { createSignInHandler } from "../../../apps/web/src/sign-in.js";
import { createSignOutHandler } from "../../../apps/web/src/sign-out.js";
import { argon2idPasswordVerifier } from "./argon2id.js";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the test fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const TENANT_B = tenantB.tenant.id;
const USER_A = tenantA.users[0]?.id ?? "";
const USER_B = tenantB.users[0]?.id ?? "";
const DOCUMENT_A = tenantA.documents[0]?.id ?? "";
const DOCUMENT_B = tenantB.documents[0]?.id ?? "";
const DEACTIVATED_USER = "c2000000-0000-0000-0001-000000000001";
const PASSWORDLESS_USER = "c2000000-0000-0000-0001-000000000002";
const DEACTIVATED_CREDENTIAL = "c2000000-0000-0000-0002-000000000001";
const DOCUMENT_READ_GRANT = "c2000000-0000-0000-0005-000000000001";
const PASSWORD = "correct horse battery staple";
const FOREIGN_PASSWORD = "foreign tenant password";
const FOREIGN_EMAIL = "foreign-only@example.test";
const REQUEST_INSTANT = new Date("2026-09-12T12:00:00.000Z");
const REQUEST_ID = "c2000000-0000-0000-0003-000000000001";
const CORRELATION_ID = "c2000000-0000-0000-0004-000000000001";

async function asPrincipal<T>(
  tenantId: string,
  principalId: string,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction({ tenantId, principal: { type: "USER", id: principalId } }, fn);
}

interface ResponseSnapshot {
  readonly status: number;
  readonly location: string | null;
  readonly cacheControl: string | null;
  readonly setCookie: string | null;
  readonly body: string;
}

async function responseSnapshot(response: Response): Promise<ResponseSnapshot> {
  return Object.freeze({
    status: response.status,
    location: response.headers.get("location"),
    cacheControl: response.headers.get("cache-control"),
    setCookie: response.headers.get("set-cookie"),
    body: await response.text(),
  });
}

function cookieToken(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /^policyoffice_session=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in response did not set a session cookie");
  return decodeURIComponent(match[1]);
}

async function auditCount(): Promise<number> {
  return asPrincipal(TENANT_A, USER_A, async (transaction) => {
    const result = await transaction.query<{ count: number }>(
      "select count(*)::int as count from audit_event where tenant_id = $1",
      [TENANT_A],
    );
    return result.rows[0]?.count ?? -1;
  });
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");

  const localPassword = await argon2idPasswordVerifier.hash(PASSWORD);
  const foreignPassword = await argon2idPasswordVerifier.hash(FOREIGN_PASSWORD);
  await asPrincipal(TENANT_A, USER_A, async (transaction) => {
    await transaction.query(
      `insert into access_grant (
         tenant_id, id, effect, principal_type, principal_id, capability,
         scope_type, scope_id, validity, granted_by, reason
       ) values (
         $1, $2, 'ALLOW', 'USER', $3, 'document.read',
         'TENANT', null, tstzrange($4::timestamptz, null, '[)'), $3,
         'POL-032 sign-in fixture'
       )`,
      [TENANT_A, DOCUMENT_READ_GRANT, USER_A, fixture.createdAt],
    );
    await transaction.query(
      `update user_credential
          set secret_hash = $3::text, params = $4::jsonb, row_version = row_version + 1
        where tenant_id = $1::uuid and user_id = $2::uuid and kind = 'PASSWORD'`,
      [TENANT_A, USER_A, localPassword.secretHash, localPassword.params],
    );
    await transaction.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values
         ($1, $2, 'Deactivated sign-in user', 'deactivated-sign-in@example.test', 'ACTIVE'),
         ($1, $3, 'Passwordless sign-in user', 'passwordless-sign-in@example.test', 'ACTIVE')`,
      [TENANT_A, DEACTIVATED_USER, PASSWORDLESS_USER],
    );
    await transaction.query(
      `insert into user_credential (tenant_id, id, user_id, kind, secret_hash, params)
       values ($1, $2, $3, 'PASSWORD', $4, $5::jsonb)`,
      [
        TENANT_A,
        DEACTIVATED_CREDENTIAL,
        DEACTIVATED_USER,
        localPassword.secretHash,
        localPassword.params,
      ],
    );
    await transaction.query(
      `update app_user
          set status = 'DEACTIVATED', deactivated_at = $3::timestamptz,
              row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid`,
      [TENANT_A, DEACTIVATED_USER, REQUEST_INSTANT.toISOString()],
    );
  });
  await asPrincipal(TENANT_B, USER_B, async (transaction) => {
    await transaction.query(
      `update app_user
          set contact_email = $3::text, row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid`,
      [TENANT_B, USER_B, FOREIGN_EMAIL],
    );
    await transaction.query(
      `update user_credential
          set secret_hash = $3::text, params = $4::jsonb, row_version = row_version + 1
        where tenant_id = $1::uuid and user_id = $2::uuid and kind = 'PASSWORD'`,
      [TENANT_B, USER_B, foreignPassword.secretHash, foreignPassword.params],
    );
  });
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the sign-in and sign-out request boundaries", () => {
  it("INV-AUTH-004 / INV-AUD-007: issues only an opaque cookie and reaches the authorised register", async () => {
    const before = await auditCount();
    const handleSignIn = createSignInHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });

    const response = await handleSignIn({
      contactEmail: tenantA.users[0]?.contactEmail ?? "",
      password: PASSWORD,
      userAgentClass: "browser",
    });
    const token = cookieToken(response);
    const snapshot = await responseSnapshot(response);

    expect(snapshot).toMatchObject({ status: 303, location: "/", cacheControl: "no-store" });
    expect(snapshot.setCookie).toMatch(
      /^policyoffice_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(snapshot.setCookie).not.toContain("Domain=");
    expect(JSON.stringify(snapshot)).not.toContain(PASSWORD);
    expect(JSON.stringify(snapshot)).not.toContain(TENANT_A);
    expect(JSON.stringify(snapshot)).not.toContain(USER_A);

    const register = await createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token });
    const body = (await register.json()) as { documents: readonly { id: string }[] };
    expect(register.status).toBe(200);
    expect(body.documents.map(({ id }) => id)).toEqual([DOCUMENT_A]);
    expect(body.documents.map(({ id }) => id)).not.toContain(DOCUMENT_B);
    await expect(auditCount()).resolves.toBe(before);
  });

  it("INV-AUTH-014 / INV-TEN-002: makes every credential failure response identical", async () => {
    const handleSignIn = createSignInHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];

    try {
      const responses = await Promise.all([
        handleSignIn({
          contactEmail: "unknown@example.test",
          password: PASSWORD,
          userAgentClass: "browser",
        }),
        handleSignIn({
          contactEmail: tenantA.users[0]?.contactEmail ?? "",
          password: "incorrect password",
          userAgentClass: "browser",
        }),
        handleSignIn({
          contactEmail: "deactivated-sign-in@example.test",
          password: PASSWORD,
          userAgentClass: "browser",
        }),
        handleSignIn({
          contactEmail: "passwordless-sign-in@example.test",
          password: PASSWORD,
          userAgentClass: "browser",
        }),
        handleSignIn({
          contactEmail: FOREIGN_EMAIL,
          password: FOREIGN_PASSWORD,
          userAgentClass: "browser",
        }),
      ]);
      const snapshots = await Promise.all(responses.map(responseSnapshot));

      expect(snapshots[0]).toEqual({
        status: 303,
        location: "/sign-in?error=1",
        cacheControl: "no-store",
        setCookie: null,
        body: "",
      });
      expect(snapshots).toEqual(snapshots.map(() => snapshots[0]));
      expect(JSON.stringify(snapshots)).not.toContain(PASSWORD);
      expect(JSON.stringify(snapshots)).not.toContain(FOREIGN_PASSWORD);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("INV-AUD-007: leaves the evidence ledger unchanged for successful and failed sign-in", async () => {
    const handleSignIn = createSignInHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const before = await auditCount();

    await handleSignIn({
      contactEmail: tenantA.users[0]?.contactEmail ?? "",
      password: PASSWORD,
      userAgentClass: "browser",
    });
    await handleSignIn({
      contactEmail: tenantA.users[0]?.contactEmail ?? "",
      password: "incorrect password",
      userAgentClass: "browser",
    });

    await expect(auditCount()).resolves.toBe(before);
  });

  it("INV-AUTH-014: signs out by deletion once and never reveals whether a session existed", async () => {
    const signInResponse = await createSignInHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      contactEmail: tenantA.users[0]?.contactEmail ?? "",
      password: PASSWORD,
      userAgentClass: "browser",
    });
    const token = cookieToken(signInResponse);
    const tokenHash = `sha-256:${createHash("sha256").update(token).digest("hex")}`;
    const sessionId = await asPrincipal(TENANT_A, USER_A, async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        "select id from user_session where tenant_id = $1 and token_hash = $2",
        [TENANT_A, tokenHash],
      );
      return result.rows[0]?.id ?? "";
    });
    const identifiers = [REQUEST_ID, CORRELATION_ID];
    const handleSignOut = createSignOutHandler({
      tenantId: TENANT_A,
      clock: () => new Date(REQUEST_INSTANT.valueOf() + 1_000),
      idFactory: () => identifiers.shift() ?? REQUEST_ID,
    });

    const first = await responseSnapshot(await handleSignOut({ sessionToken: token }));
    const second = await responseSnapshot(await handleSignOut({ sessionToken: token }));
    const missing = await responseSnapshot(await handleSignOut({ sessionToken: undefined }));

    expect(first).toEqual({
      status: 303,
      location: "/sign-in",
      cacheControl: "no-store",
      setCookie: "policyoffice_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      body: "",
    });
    expect(second).toEqual(first);
    expect(missing).toEqual(first);

    await asPrincipal(TENANT_A, USER_A, async (transaction) => {
      const sessions = await transaction.query<{ count: number }>(
        "select count(*)::int as count from user_session where tenant_id = $1 and id = $2",
        [TENANT_A, sessionId],
      );
      const events = await transaction.query<{
        event_type: string;
        actor_id: string;
        subject_id: string;
        safe_before: { sessionId: string };
      }>(
        `select event_type, actor_id, subject_id, safe_before
           from audit_event
          where tenant_id = $1 and event_type = 'session.revoked'
            and safe_before ->> 'sessionId' = $2`,
        [TENANT_A, sessionId],
      );
      expect(sessions.rows).toEqual([{ count: 0 }]);
      expect(events.rows).toEqual([
        {
          event_type: "session.revoked",
          actor_id: USER_A,
          subject_id: USER_A,
          safe_before: { sessionId },
        },
      ]);
    });

    const register = await createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => new Date(REQUEST_INSTANT.valueOf() + 2_000),
    })({ sessionToken: token });
    expect(register.status).toBe(404);
  });
});
