import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { issueSession } from "../../domain/src/index.js";
import { createDocumentRegisterHandler } from "../../../apps/web/src/document-register.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the test fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const TENANT_B = tenantB.tenant.id;
const FIXTURE_USER_A = tenantA.users[0]?.id ?? "";
const FIXTURE_USER_B = tenantB.users[0]?.id ?? "";
const DOCUMENT_A = tenantA.documents[0]?.id ?? "";
const DOCUMENT_B = tenantB.documents[0]?.id ?? "";
const AUTHORIZED_USER = "c1000000-0000-0000-0001-000000000001";
const UNAUTHORIZED_USER = "c1000000-0000-0000-0001-000000000002";
const DEACTIVATED_USER = "c1000000-0000-0000-0001-000000000003";
const DOCUMENT_READ_GRANT = "c1000000-0000-0000-0002-000000000001";
// Deliberately old: substituting wall-clock time for the request instant expires both the
// session and grant, so the fixed-instant assertion is behavioural rather than a spy alone.
const REQUEST_INSTANT = new Date("2026-09-10T12:00:00.000Z");
const FIVE_MINUTES = 5 * 60 * 1_000;
const THIRTEEN_HOURS = 13 * 60 * 60 * 1_000;

let authorizedToken = "";
let unauthorizedToken = "";
let expiredToken = "";
let deactivatedToken = "";
let foreignToken = "";

function beforeRequest(milliseconds: number): Date {
  return new Date(REQUEST_INSTANT.valueOf() - milliseconds);
}

async function asPrincipal<T>(
  tenantId: string,
  principalId: string,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction({ tenantId, principal: { type: "USER", id: principalId } }, fn);
}

async function sessionFor(tenantId: string, userId: string, instant: Date): Promise<string> {
  const issued = await asPrincipal(tenantId, userId, (transaction) =>
    issueSession(transaction, {
      tenantId,
      userId,
      userAgentClass: "POL-031 direct handler test",
      instant,
    }),
  );
  return issued.token;
}

async function responseShape(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return Object.freeze({
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  });
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");

  await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
    await transaction.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values
         ($1, $2, 'Authorized register reader', 'authorized-register@example.test', 'ACTIVE'),
         ($1, $3, 'Unauthorized register reader', 'unauthorized-register@example.test', 'ACTIVE'),
         ($1, $4, 'Deactivated register reader', 'deactivated-register@example.test', 'ACTIVE')`,
      [TENANT_A, AUTHORIZED_USER, UNAUTHORIZED_USER, DEACTIVATED_USER],
    );
    await transaction.query(
      `insert into access_grant (
         tenant_id, id, effect, principal_type, principal_id, capability,
         scope_type, scope_id, validity, granted_by, reason
       ) values (
         $1, $2, 'ALLOW', 'USER', $3, 'document.read',
         'TENANT', null, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6,
         'POL-031 request-boundary fixture'
       )`,
      [
        TENANT_A,
        DOCUMENT_READ_GRANT,
        AUTHORIZED_USER,
        beforeRequest(FIVE_MINUTES * 2).toISOString(),
        new Date(REQUEST_INSTANT.valueOf() + FIVE_MINUTES).toISOString(),
        FIXTURE_USER_A,
      ],
    );
  });

  authorizedToken = await sessionFor(TENANT_A, AUTHORIZED_USER, beforeRequest(FIVE_MINUTES));
  unauthorizedToken = await sessionFor(TENANT_A, UNAUTHORIZED_USER, beforeRequest(FIVE_MINUTES));
  expiredToken = await sessionFor(TENANT_A, UNAUTHORIZED_USER, beforeRequest(THIRTEEN_HOURS));
  deactivatedToken = await sessionFor(TENANT_A, DEACTIVATED_USER, beforeRequest(FIVE_MINUTES));
  foreignToken = await sessionFor(TENANT_B, FIXTURE_USER_B, beforeRequest(FIVE_MINUTES));

  await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
    await transaction.query(
      `update app_user
          set status = 'DEACTIVATED', row_version = row_version + 1
        where tenant_id = $1 and id = $2`,
      [TENANT_A, DEACTIVATED_USER],
    );
  });
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the document-register request boundary", () => {
  it("INV-AUTH-001: makes missing, unknown, expired and deactivated sessions identical", async () => {
    const handle = createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });

    const responses = await Promise.all([
      handle({ sessionToken: undefined }),
      handle({ sessionToken: "unknown-session-token" }),
      handle({ sessionToken: expiredToken }),
      handle({ sessionToken: deactivatedToken }),
    ]);
    const shapes = await Promise.all(responses.map(responseShape));

    expect(shapes[0]).toEqual({
      status: 404,
      contentType: "application/json",
      cacheControl: "no-store",
      body: '{"error":"not_found"}',
    });
    expect(shapes).toEqual(shapes.map(() => shapes[0]));
  });

  it("INV-TEN-002 / INV-AUTH-012: reveals no register metadata across either denial boundary", async () => {
    const handle = createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });

    const absent = await responseShape(await handle({ sessionToken: "absent-session-token" }));
    const unauthorized = await responseShape(await handle({ sessionToken: unauthorizedToken }));
    const crossTenant = await responseShape(await handle({ sessionToken: foreignToken }));

    expect(unauthorized).toEqual(absent);
    expect(crossTenant).toEqual(absent);
    expect(JSON.stringify([unauthorized, crossTenant])).not.toContain(
      tenantA.documents[0]?.canonicalTitle,
    );
    expect(JSON.stringify([unauthorized, crossTenant])).not.toContain(
      tenantB.documents[0]?.canonicalTitle,
    );
  });

  it("INV-AUTH-001 / INV-TEN-004: returns only the configured tenant's authorized register", async () => {
    const handle = createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });

    const response = await handle({ sessionToken: authorizedToken });
    const body = (await response.json()) as { documents: readonly { id: string }[] };

    expect(response.status).toBe(200);
    expect(body.documents.map((document) => document.id)).toEqual([DOCUMENT_A]);
    expect(body.documents.map((document) => document.id)).not.toContain(DOCUMENT_B);
  });

  it("INV-AUTH-004: captures one instant for both session and authorization validity", async () => {
    const clock = vi.fn(() => REQUEST_INSTANT);
    const handle = createDocumentRegisterHandler({ tenantId: TENANT_A, clock });

    const response = await handle({ sessionToken: authorizedToken });

    expect(response.status).toBe(200);
    expect(clock).toHaveBeenCalledOnce();
  });
});
