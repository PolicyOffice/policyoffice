import {
  AUTHORIZATION_PRINCIPAL_TYPES,
  type AuditTransaction,
  type PrincipalRef,
} from "../../domain/src/index.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type Client, type PoolClient } from "pg";
import type { AuthorizationTransaction } from "./authorization.js";
import * as schema from "./schema.js";

const DEFAULT_APPLICATION_DATABASE_URL = "postgres://app_role:app_role@localhost:5432/policyoffice";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identity and tenant fixed at the request or job boundary. */
export interface TenantContext {
  readonly tenantId: string;
  readonly principal: PrincipalRef;
}

/**
 * The only application database handle. Raw SQL domain functions and the authorization
 * loader consume `query` directly; Drizzle uses the same physical transaction through
 * `drizzle` rather than opening another connection.
 */
export interface ApplicationTransaction extends AuditTransaction, AuthorizationTransaction {
  readonly context: TenantContext;
  readonly drizzle: NodePgDatabase<typeof schema>;
}

type ApplicationClient = Client | PoolClient;

interface ApplicationConnectionSource {
  connect(): Promise<ApplicationClient>;
}

const applicationPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? DEFAULT_APPLICATION_DATABASE_URL,
  // Never inherit a privileged username from a deployment URL. A wrong app_role password
  // fails closed; a migration or superuser connection must never become the application.
  user: "app_role",
  allowExitOnIdle: true,
});

function tenantContext(value: unknown): TenantContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("context must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId)) {
    throw new TypeError("context.tenantId must be a UUID");
  }
  if (typeof input.principal !== "object" || input.principal === null) {
    throw new TypeError("context.principal must be an object");
  }
  const principal = input.principal as Record<string, unknown>;
  const principalType = AUTHORIZATION_PRINCIPAL_TYPES.find((type) => type === principal.type);
  if (principalType === undefined) {
    throw new TypeError("context.principal.type is not supported");
  }
  if (typeof principal.id !== "string" || !UUID.test(principal.id)) {
    throw new TypeError("context.principal.id must be a UUID");
  }
  return Object.freeze({
    tenantId: input.tenantId,
    principal: Object.freeze({ type: principalType, id: principal.id }),
  });
}

function transactionHandle(
  client: ApplicationClient,
  context: TenantContext,
): ApplicationTransaction {
  return Object.freeze({
    context,
    drizzle: drizzle(client, { schema }),
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await client.query(text, values);
      return { rows: result.rows as Row[] };
    },
  });
}

function release(client: ApplicationClient): void {
  if ("release" in client) client.release();
}

/**
 * INV-TEN-004: the one production application function that opens a transaction.
 * Context is validated before a connection is acquired, and the callback is not invoked
 * until the transaction-local tenant setting succeeds.
 */
export async function withTenantTransaction<T>(
  contextInput: TenantContext,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
  connectionSource: ApplicationConnectionSource = applicationPool,
): Promise<T> {
  const context = tenantContext(contextInput);
  if (typeof fn !== "function") throw new TypeError("fn must be a function");

  const client = await connectionSource.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    const setting = await client.query<{ application_role: string }>(
      `select set_config('app.tenant_id', $1, true), current_user as application_role`,
      [context.tenantId],
    );
    if (setting.rows[0]?.application_role !== "app_role") {
      throw new Error("application transaction requires app_role");
    }

    const result = await fn(transactionHandle(client, context));
    await client.query("commit");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "application transaction and rollback both failed",
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    release(client);
  }
}
