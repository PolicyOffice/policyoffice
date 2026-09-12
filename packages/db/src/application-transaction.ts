import {
  AUTHORIZATION_PRINCIPAL_TYPES,
  resolveSession,
  verifyPasswordCredential,
  type AuditTransaction,
  type PasswordVerifier,
  type PrincipalRef,
} from "../../domain/src/index.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type Client, type PoolClient } from "pg";
import type { AuthorizationTransaction } from "./authorization.js";
import { argon2idPasswordVerifier } from "./argon2id.js";
import * as schema from "./schema.js";

const DEFAULT_APPLICATION_DATABASE_URL = "postgres://app_role:app_role@localhost:5432/policyoffice";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identity and tenant fixed at the request or job boundary. */
export interface TenantContext {
  readonly tenantId: string;
  readonly principal: PrincipalRef;
}

/** The request-boundary shape used until its opaque session token resolves a principal. */
export interface SessionTenantContext {
  readonly tenantId: string;
  readonly sessionToken: string;
  readonly instant: Date;
}

/** The sign-in boundary before a local credential resolves a principal. */
export interface CredentialTenantContext {
  readonly tenantId: string;
  readonly credential: Readonly<{
    contactEmail: string;
    password: string;
  }>;
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

function sessionTenantContext(value: unknown): SessionTenantContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("context must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId)) {
    throw new TypeError("context.tenantId must be a UUID");
  }
  if (typeof input.sessionToken !== "string") {
    throw new TypeError("context.sessionToken must be a string");
  }
  if (!(input.instant instanceof Date) || Number.isNaN(input.instant.valueOf())) {
    throw new TypeError("context.instant must be a valid Date");
  }
  return Object.freeze({
    tenantId: input.tenantId,
    sessionToken: input.sessionToken,
    instant: new Date(input.instant.valueOf()),
  });
}

function credentialTenantContext(value: unknown): CredentialTenantContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("context must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId)) {
    throw new TypeError("context.tenantId must be a UUID");
  }
  if (typeof input.credential !== "object" || input.credential === null) {
    throw new TypeError("context.credential must be an object");
  }
  const credential = input.credential as Record<string, unknown>;
  if (typeof credential.contactEmail !== "string" || credential.contactEmail.trim().length === 0) {
    throw new TypeError("context.credential.contactEmail is required");
  }
  if (typeof credential.password !== "string" || credential.password.trim().length === 0) {
    throw new TypeError("context.credential.password is required");
  }
  return Object.freeze({
    tenantId: input.tenantId,
    credential: Object.freeze({
      contactEmail: credential.contactEmail,
      password: credential.password,
    }),
  });
}

function transactionContext(
  value: TenantContext | SessionTenantContext | CredentialTenantContext,
): TenantContext | SessionTenantContext | CredentialTenantContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("context must be an object");
  }
  const input = value as unknown as Record<string, unknown>;
  const carriesPrincipal = Object.hasOwn(input, "principal");
  const carriesSession = Object.hasOwn(input, "sessionToken") || Object.hasOwn(input, "instant");
  const carriesCredential = Object.hasOwn(input, "credential");
  if (Number(carriesPrincipal) + Number(carriesSession) + Number(carriesCredential) !== 1) {
    throw new TypeError("context must carry exactly one of principal, session, or credential");
  }
  if (carriesPrincipal) return tenantContext(input);
  return carriesSession ? sessionTenantContext(input) : credentialTenantContext(input);
}

function queryHandle(client: ApplicationClient): AuditTransaction {
  return Object.freeze({
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await client.query(text, values);
      return { rows: result.rows as Row[] };
    },
  });
}

function transactionHandle(
  client: ApplicationClient,
  context: TenantContext,
): ApplicationTransaction {
  const query = queryHandle(client);
  return Object.freeze({
    context,
    drizzle: drizzle(client, { schema }),
    query: query.query,
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
export function withTenantTransaction<T>(
  contextInput: TenantContext,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
  connectionSource?: ApplicationConnectionSource,
  passwordVerifier?: PasswordVerifier,
): Promise<T>;
export function withTenantTransaction<T>(
  contextInput: SessionTenantContext,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
  connectionSource?: ApplicationConnectionSource,
  passwordVerifier?: PasswordVerifier,
): Promise<T | null>;
export function withTenantTransaction<T>(
  contextInput: CredentialTenantContext,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
  connectionSource?: ApplicationConnectionSource,
  passwordVerifier?: PasswordVerifier,
): Promise<T | null>;
export async function withTenantTransaction<T>(
  contextInput: TenantContext | SessionTenantContext | CredentialTenantContext,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
  connectionSource: ApplicationConnectionSource = applicationPool,
  passwordVerifier: PasswordVerifier = argon2idPasswordVerifier,
): Promise<T | null> {
  const input = transactionContext(contextInput);
  if (typeof fn !== "function") throw new TypeError("fn must be a function");

  const client = await connectionSource.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    const setting = await client.query<{ application_role: string }>(
      `select set_config('app.tenant_id', $1, true), current_user as application_role`,
      [input.tenantId],
    );
    if (setting.rows[0]?.application_role !== "app_role") {
      throw new Error("application transaction requires app_role");
    }

    let context: TenantContext;
    if ("principal" in input) {
      context = input;
    } else if ("sessionToken" in input) {
      const principal = await resolveSession(queryHandle(client), {
        tenantId: input.tenantId,
        token: input.sessionToken,
        instant: input.instant,
      });
      if (principal === null) {
        await client.query("rollback");
        transactionOpen = false;
        return null;
      }
      context = Object.freeze({ tenantId: input.tenantId, principal });
    } else {
      const principal = await verifyPasswordCredential(queryHandle(client), passwordVerifier, {
        tenantId: input.tenantId,
        contactEmail: input.credential.contactEmail,
        password: input.credential.password,
      });
      if (principal === null) {
        await client.query("rollback");
        transactionOpen = false;
        return null;
      }
      context = Object.freeze({ tenantId: input.tenantId, principal });
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
