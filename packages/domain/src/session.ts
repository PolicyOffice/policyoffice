import { createHash, randomBytes } from "node:crypto";
import {
  emitAuditEvent,
  emitAuditEvents,
  type AuditActorType,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";

export const SESSION_TOKEN_BYTES = 32;

// ADR-0002 requires tenant-configurable values within product bounds. The configuration
// schema has no session fields yet, so POL-029 deliberately starts with named product values.
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1_000;

export type PasswordHashParameter = string | number | boolean;

export interface PasswordHash {
  readonly secretHash: string;
  readonly params: Readonly<Record<string, PasswordHashParameter>>;
}

/** Framework-free boundary implemented by the Argon2id adapter outside this package. */
export interface PasswordVerifier {
  hash(secret: string): Promise<PasswordHash>;
  verify(secret: string, passwordHash: PasswordHash): Promise<boolean>;
}

export interface SessionPrincipal {
  readonly type: "USER";
  readonly id: string;
}

export interface IssueSessionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly userAgentClass: string;
  readonly instant: Date;
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
  readonly principal: SessionPrincipal;
  readonly issuedAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface ResolveSessionInput {
  readonly tenantId: string;
  readonly token: string;
  readonly instant: Date;
}

export interface VerifyPasswordCredentialInput {
  readonly tenantId: string;
  readonly contactEmail: string;
  readonly password: string;
}

interface SessionAuditContext {
  readonly tenantId: string;
  readonly actor: Readonly<{ type: AuditActorType; id: string | null }>;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sourceChannel: AuditSourceChannel;
  readonly configurationVersionId: string;
}

export interface RevokeSessionInput extends SessionAuditContext {
  readonly sessionId: string;
}

export interface RevokeAllSessionsInput extends SessionAuditContext {
  readonly userId: string;
}

export interface DeactivateUserInput extends SessionAuditContext {
  readonly userId: string;
}

export interface RevokedSessions {
  readonly sessionIds: readonly string[];
  readonly emittedEvents: readonly EmittedAuditEvent[];
}

interface IssuedSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  issued_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
}

interface StoredSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  user_status: string;
}

interface PasswordCredentialRow extends Record<string, unknown> {
  user_id: string;
  secret_hash: string;
  params: unknown;
}

interface RevokedSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
}

interface UserStatusRow extends Record<string, unknown> {
  id: string;
  status: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

export class SessionPrincipalUnavailableError extends Error {
  constructor() {
    super("session principal is unavailable");
    this.name = "SessionPrincipalUnavailableError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function requireInstant(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function validateAuditContext(input: SessionAuditContext): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireInstant(input.occurredAt, "occurredAt");
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
}

function instantPlus(instant: Date, milliseconds: number): Date {
  return new Date(instant.valueOf() + milliseconds);
}

function tokenHash(token: string): string {
  return `sha-256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function principal(userId: string): SessionPrincipal {
  return Object.freeze({ type: "USER", id: userId });
}

function passwordHashParameters(value: unknown): PasswordHash["params"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => !["string", "number", "boolean"].includes(typeof item))) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, PasswordHashParameter>);
}

export async function hashPassword(
  verifier: PasswordVerifier,
  password: string,
): Promise<PasswordHash> {
  requireText(password, "password");
  const passwordHash = await verifier.hash(password);
  requireText(passwordHash.secretHash, "passwordHash.secretHash");
  const params = passwordHashParameters(passwordHash.params);
  if (params === null) throw new TypeError("passwordHash.params is invalid");
  return Object.freeze({ secretHash: passwordHash.secretHash, params });
}

/**
 * Issue one bearer token. The token is returned from this call and is never sent to the
 * transaction; only its deterministic digest crosses the persistence boundary.
 */
export async function issueSession(
  transaction: AuditTransaction,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.userId, "userId");
  requireText(input.userAgentClass, "userAgentClass");
  requireInstant(input.instant, "instant");

  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const idleExpiresAt = instantPlus(input.instant, SESSION_IDLE_TIMEOUT_MS);
  const absoluteExpiresAt = instantPlus(input.instant, SESSION_ABSOLUTE_LIFETIME_MS);
  const { rows } = await transaction.query<IssuedSessionRow>(
    `with active_user as materialized (
       select id
         from app_user
        where tenant_id = $1::uuid and id = $2::uuid and status = 'ACTIVE'
        for share
     )
     insert into user_session (
       tenant_id, user_id, token_hash, issued_at, idle_expires_at,
       absolute_expires_at, user_agent_class
     )
     select $1::uuid, active_user.id, $3::text, $4::timestamptz, $5::timestamptz,
            $6::timestamptz, $7::text
       from active_user
     returning id, user_id, issued_at, idle_expires_at, absolute_expires_at`,
    [
      input.tenantId,
      input.userId,
      tokenHash(token),
      input.instant.toISOString(),
      idleExpiresAt.toISOString(),
      absoluteExpiresAt.toISOString(),
      input.userAgentClass,
    ],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) throw new SessionPrincipalUnavailableError();

  return Object.freeze({
    id: row.id,
    token,
    principal: principal(row.user_id),
    issuedAt: row.issued_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  });
}

/** Resolve identity and slide the idle deadline. Every call re-reads app_user.status. */
export async function resolveSession(
  transaction: AuditTransaction,
  input: ResolveSessionInput,
): Promise<SessionPrincipal | null> {
  requireUuid(input.tenantId, "tenantId");
  requireInstant(input.instant, "instant");
  if (typeof input.token !== "string") return null;

  const { rows } = await transaction.query<StoredSessionRow>(
    `select session.id,
            session.user_id,
            session.idle_expires_at,
            session.absolute_expires_at,
            principal.status as user_status
       from user_session session
       join app_user principal
         on principal.tenant_id = session.tenant_id and principal.id = session.user_id
      where session.tenant_id = $1::uuid and session.token_hash = $2::text
      for update of session`,
    [input.tenantId, tokenHash(input.token)],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) return null;

  const at = input.instant.valueOf();
  if (
    row.user_status !== "ACTIVE" ||
    at >= row.idle_expires_at.valueOf() ||
    at >= row.absolute_expires_at.valueOf()
  ) {
    return null;
  }

  const proposedIdleExpiry = instantPlus(input.instant, SESSION_IDLE_TIMEOUT_MS).valueOf();
  const refreshedIdleExpiry = new Date(
    Math.min(
      row.absolute_expires_at.valueOf(),
      Math.max(row.idle_expires_at.valueOf(), proposedIdleExpiry),
    ),
  );
  await transaction.query(
    `update user_session
        set idle_expires_at = $3::timestamptz,
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid`,
    [input.tenantId, row.id, refreshedIdleExpiry.toISOString()],
  );
  return principal(row.user_id);
}

/** Verify only local PASSWORD credentials. A mismatch emits no governance audit event. */
export async function verifyPasswordCredential(
  transaction: AuditTransaction,
  verifier: PasswordVerifier,
  input: VerifyPasswordCredentialInput,
): Promise<SessionPrincipal | null> {
  requireUuid(input.tenantId, "tenantId");
  requireText(input.contactEmail, "contactEmail");
  requireText(input.password, "password");

  const { rows } = await transaction.query<PasswordCredentialRow>(
    `select principal.id as user_id, credential.secret_hash, credential.params
       from app_user principal
       join user_credential credential
         on credential.tenant_id = principal.tenant_id and credential.user_id = principal.id
      where principal.tenant_id = $1::uuid
        and lower(principal.contact_email) = lower($2::text)
        and principal.status = 'ACTIVE'
        and credential.kind = 'PASSWORD'
      order by credential.created_at desc
      limit 2`,
    [input.tenantId, input.contactEmail],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  const params = passwordHashParameters(row.params);
  if (params === null) return null;

  const matches = await verifier.verify(input.password, {
    secretHash: row.secret_hash,
    params,
  });
  return matches ? principal(row.user_id) : null;
}

function revocationEvent(
  input: SessionAuditContext,
  row: RevokedSessionRow,
  action: "REVOKE_SESSION" | "REVOKE_ALL_SESSIONS" | "REVOKE_SESSION_ON_DEACTIVATION",
): AuditEventInput {
  return {
    tenantId: input.tenantId,
    eventType: "session.revoked",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "USER", id: row.user_id },
    action,
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: { sessionId: row.id },
    safeAfter: null,
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `session.revoked:${row.id}`,
  };
}

async function emitRevocations(
  transaction: AuditTransaction,
  input: SessionAuditContext,
  rows: readonly RevokedSessionRow[],
  action: "REVOKE_ALL_SESSIONS" | "REVOKE_SESSION_ON_DEACTIVATION",
): Promise<RevokedSessions> {
  if (rows.length === 0) return Object.freeze({ sessionIds: [], emittedEvents: [] });
  const emittedEvents = await emitAuditEvents(
    transaction,
    rows.map((row) => revocationEvent(input, row, action)),
  );
  return Object.freeze({
    sessionIds: Object.freeze(rows.map((row) => row.id)),
    emittedEvents: Object.freeze(emittedEvents),
  });
}

export async function revokeSession(
  transaction: AuditTransaction,
  input: RevokeSessionInput,
): Promise<RevokedSessions | null> {
  validateAuditContext(input);
  requireUuid(input.sessionId, "sessionId");
  const { rows } = await transaction.query<RevokedSessionRow>(
    `delete from user_session
      where tenant_id = $1::uuid and id = $2::uuid
    returning id, user_id`,
    [input.tenantId, input.sessionId],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  const emittedEvent = await emitAuditEvent(
    transaction,
    revocationEvent(input, row, "REVOKE_SESSION"),
  );
  return Object.freeze({
    sessionIds: Object.freeze([row.id]),
    emittedEvents: Object.freeze([emittedEvent]),
  });
}

export async function revokeAllSessions(
  transaction: AuditTransaction,
  input: RevokeAllSessionsInput,
): Promise<RevokedSessions> {
  validateAuditContext(input);
  requireUuid(input.userId, "userId");
  const principalRows = await transaction.query<UserStatusRow>(
    `select id, status
       from app_user
      where tenant_id = $1::uuid and id = $2::uuid
      for update`,
    [input.tenantId, input.userId],
  );
  if (principalRows.rows.length !== 1) {
    return Object.freeze({ sessionIds: [], emittedEvents: [] });
  }
  const { rows } = await transaction.query<RevokedSessionRow>(
    `delete from user_session
      where tenant_id = $1::uuid and user_id = $2::uuid
    returning id, user_id`,
    [input.tenantId, input.userId],
  );
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return emitRevocations(transaction, input, rows, "REVOKE_ALL_SESSIONS");
}

/**
 * Lock the principal, remember the sessions, and let 0003's deactivation trigger delete
 * them. Audit emission shares the caller's transaction, so failure restores both states.
 */
export async function deactivateUserAndRevokeSessions(
  transaction: AuditTransaction,
  input: DeactivateUserInput,
): Promise<RevokedSessions> {
  validateAuditContext(input);
  requireUuid(input.userId, "userId");

  const principalRows = await transaction.query<UserStatusRow>(
    `select id, status
       from app_user
      where tenant_id = $1::uuid and id = $2::uuid
      for update`,
    [input.tenantId, input.userId],
  );
  const user = principalRows.rows[0];
  if (!user || principalRows.rows.length !== 1) throw new SessionPrincipalUnavailableError();
  if (user.status === "DEACTIVATED") {
    return Object.freeze({ sessionIds: [], emittedEvents: [] });
  }

  const sessions = await transaction.query<RevokedSessionRow>(
    `select id, user_id
       from user_session
      where tenant_id = $1::uuid and user_id = $2::uuid
      order by id
      for update`,
    [input.tenantId, input.userId],
  );
  await transaction.query(
    `update app_user
        set status = 'DEACTIVATED',
            deactivated_at = $3::timestamptz,
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid`,
    [input.tenantId, input.userId, input.occurredAt.toISOString()],
  );

  return emitRevocations(transaction, input, sessions.rows, "REVOKE_SESSION_ON_DEACTIVATION");
}
