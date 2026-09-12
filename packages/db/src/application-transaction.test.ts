import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  withTenantTransaction,
  type ApplicationTransaction,
  type SessionTenantContext,
  type TenantContext,
} from "./application-transaction.js";

const CONTEXT: TenantContext = Object.freeze({
  tenantId: "a0000000-0000-0000-0000-000000000001",
  principal: Object.freeze({ type: "USER", id: "a0000000-0000-0000-0001-000000000001" }),
});
const SESSION_CONTEXT: SessionTenantContext = Object.freeze({
  tenantId: CONTEXT.tenantId,
  sessionToken: "unknown-session-token",
  instant: new Date("2026-09-11T09:00:00.000Z"),
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
