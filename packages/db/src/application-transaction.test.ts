import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  withTenantTransaction,
  type ApplicationTransaction,
  type CredentialTenantContext,
  type SessionTenantContext,
  type TenantContext,
} from "./application-transaction.js";
import type { PasswordHash, PasswordVerifier } from "../../domain/src/index.js";

const CONTEXT: TenantContext = Object.freeze({
  tenantId: "a0000000-0000-0000-0000-000000000001",
  principal: Object.freeze({ type: "USER", id: "a0000000-0000-0000-0001-000000000001" }),
});
const SESSION_CONTEXT: SessionTenantContext = Object.freeze({
  tenantId: CONTEXT.tenantId,
  sessionToken: "unknown-session-token",
  instant: new Date("2026-09-11T09:00:00.000Z"),
});
const CREDENTIAL_CONTEXT: CredentialTenantContext = Object.freeze({
  tenantId: CONTEXT.tenantId,
  credential: Object.freeze({
    contactEmail: "person@example.test",
    password: "correct horse battery staple",
  }),
});
const PASSWORD_VERIFIER: PasswordVerifier = Object.freeze({
  async hash(secret: string) {
    return { secretHash: `fake:${secret}`, params: { algorithm: "fake" } };
  },
  async verify(secret: string, passwordHash: PasswordHash) {
    return passwordHash.secretHash === `fake:${secret}`;
  },
});

type ConnectionSource = NonNullable<Parameters<typeof withTenantTransaction>[2]>;
type ApplicationClient = Awaited<ReturnType<ConnectionSource["connect"]>>;

function connectionSource(query: (text: string, values?: unknown[]) => Promise<unknown>): {
  readonly source: ConnectionSource;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client = { query, release } as unknown as ApplicationClient;
  const connect = vi.fn(async () => client);
  return { source: { connect }, connect, release };
}

describe("the application transaction boundary", () => {
  it("exposes only authenticated handles to a session-token callback", () => {
    type SessionOpener = <T>(
      context: SessionTenantContext,
      fn: (transaction: ApplicationTransaction) => Promise<T>,
    ) => Promise<T | null>;

    expectTypeOf(withTenantTransaction).toMatchTypeOf<SessionOpener>();
  });

  it("exposes only authenticated handles to a credential callback", () => {
    type CredentialOpener = <T>(
      context: CredentialTenantContext,
      fn: (transaction: ApplicationTransaction) => Promise<T>,
    ) => Promise<T | null>;

    expectTypeOf(withTenantTransaction).toMatchTypeOf<CredentialOpener>();
  });

  it("INV-TEN-004: validates context and sets the tenant before yielding", async () => {
    const statements: string[] = [];
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      return {
        rows: text.includes("set_config") ? [{ application_role: "app_role" }] : [],
      };
    });

    const result = await withTenantTransaction(
      CONTEXT,
      async (transaction) => {
        expect(statements).toEqual([
          "begin",
          "select set_config('app.tenant_id', $1, true), current_user as application_role",
        ]);
        expect(transaction.context).toEqual(CONTEXT);
        return "yielded";
      },
      source,
    );

    expect(result).toBe("yielded");
    expect(statements).toEqual([
      "begin",
      "select set_config('app.tenant_id', $1, true), current_user as application_role",
      "commit",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    [
      "malformed",
      {
        tenantId: "not-a-uuid",
        principal: { type: "USER", id: CONTEXT.principal.id },
      },
    ],
    [
      "ambiguous",
      {
        ...CONTEXT,
        credential: CREDENTIAL_CONTEXT.credential,
      },
    ],
  ])("INV-TEN-004: does not acquire or yield for a %s context", async (_case, context) => {
    const { source, connect } = connectionSource(async () => ({ rows: [] }));
    const fn = vi.fn(async () => undefined);

    await expect(withTenantTransaction(context as never, fn, source)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("INV-TEN-004: rolls back and does not yield when set_config fails", async () => {
    const statements: string[] = [];
    const settingFailure = new Error("setting unavailable");
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      if (text.includes("set_config")) throw settingFailure;
      return { rows: [] };
    });
    const fn = vi.fn(async () => undefined);

    await expect(withTenantTransaction(CONTEXT, fn, source)).rejects.toBe(settingFailure);
    expect(fn).not.toHaveBeenCalled();
    expect(statements).toEqual([
      "begin",
      "select set_config('app.tenant_id', $1, true), current_user as application_role",
      "rollback",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("INV-AUTH-001: rolls back and does not yield when a session does not resolve", async () => {
    const statements: string[] = [];
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      return {
        rows: text.includes("set_config") ? [{ application_role: "app_role" }] : [],
      };
    });
    const fn = vi.fn(async () => undefined);

    await expect(withTenantTransaction(SESSION_CONTEXT, fn, source)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(statements.slice(0, 2)).toEqual([
      "begin",
      "select set_config('app.tenant_id', $1, true), current_user as application_role",
    ]);
    expect(statements[2]).toContain("from user_session session");
    expect(statements.at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("INV-AUTH-014: resolves a credential before yielding the one tenant handle", async () => {
    const statements: string[] = [];
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      if (text.includes("set_config")) return { rows: [{ application_role: "app_role" }] };
      if (text.includes("from app_user principal")) {
        return {
          rows: [
            {
              user_id: CONTEXT.principal.id,
              secret_hash: "fake:correct horse battery staple",
              params: { algorithm: "fake" },
            },
          ],
        };
      }
      return { rows: [] };
    });

    const observed = await withTenantTransaction(
      CREDENTIAL_CONTEXT,
      async (transaction) => transaction.context,
      source,
      PASSWORD_VERIFIER,
    );

    expect(observed).toEqual(CONTEXT);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toContain("set_config");
    expect(statements[2]).toContain("from app_user principal");
    expect(statements.at(-1)).toBe("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("INV-AUD-007: rolls back and does not yield when a credential does not resolve", async () => {
    const statements: string[] = [];
    const verifier: PasswordVerifier = {
      hash: vi.fn(PASSWORD_VERIFIER.hash),
      verify: vi.fn(PASSWORD_VERIFIER.verify),
    };
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      return {
        rows: text.includes("set_config") ? [{ application_role: "app_role" }] : [],
      };
    });
    const fn = vi.fn(async () => undefined);

    await expect(
      withTenantTransaction(CREDENTIAL_CONTEXT, fn, source, verifier),
    ).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(verifier.hash).toHaveBeenCalledOnce();
    expect(statements.at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("INV-TEN-004: refuses to yield a privileged connection", async () => {
    const statements: string[] = [];
    const { source, release } = connectionSource(async (text) => {
      statements.push(text);
      return {
        rows: text.includes("set_config") ? [{ application_role: "migration_role" }] : [],
      };
    });
    const fn = vi.fn(async () => undefined);

    await expect(withTenantTransaction(CONTEXT, fn, source)).rejects.toThrow(
      "application transaction requires app_role",
    );
    expect(fn).not.toHaveBeenCalled();
    expect(statements).toEqual([
      "begin",
      "select set_config('app.tenant_id', $1, true), current_user as application_role",
      "rollback",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
