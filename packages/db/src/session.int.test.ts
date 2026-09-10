import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  deactivateUserAndRevokeSessions,
  issueSession,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  verifyPasswordCredential,
  type AuditTransaction,
  type PasswordVerifier,
} from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "a3000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "a4000000-0000-0000-0000-000000000002";
const USER = "a3000000-0000-0000-0001-000000000001";
const OTHER_USER = "a4000000-0000-0000-0001-000000000002";
const CONFIGURATION = "a3000000-0000-0000-0002-000000000001";
const OTHER_CONFIGURATION = "a4000000-0000-0000-0002-000000000002";
const REQUEST = "a3000000-0000-0000-0003-000000000001";
const CORRELATION = "a3000000-0000-0000-0004-000000000001";
const FIXED_INSTANT = new Date("2027-03-01T09:00:00.000Z");

let otherTenantToken = "";

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

async function inCommittedTenant<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withAppRole(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(sql);
      await sql.query("commit");
      return result;
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

async function clearTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const table of [
      "audit_event",
      "user_session",
      "user_credential",
      "tenant_event_sequence",
      "configuration_version",
      "app_user",
    ]) {
      await sql.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
    }
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function seedTenant(
  tenantId: string,
  userId: string,
  configurationId: string,
  label: string,
): Promise<void> {
  await inCommittedTenant(tenantId, async (sql) => {
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [tenantId, userId, `${label} session user`, `${label.toLowerCase()}-session@example.test`],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, $3, $4, 'Initial session test configuration', false, $5)`,
      [
        tenantId,
        configurationId,
        FIXED_INSTANT.toISOString(),
        userId,
        `sha256:${label.toLowerCase()}-session-configuration`,
      ],
    );
  });
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Session tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other session tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
  });
  await seedTenant(TENANT, USER, CONFIGURATION, "A");
  await seedTenant(OTHER_TENANT, OTHER_USER, OTHER_CONFIGURATION, "B");
  otherTenantToken = await inCommittedTenant(OTHER_TENANT, async (sql) => {
    const issued = await issueSession(transaction(sql), {
      tenantId: OTHER_TENANT,
      userId: OTHER_USER,
      userAgentClass: "browser",
      instant: FIXED_INSTANT,
    });
    return issued.token;
  });
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
  });
}

function auditContext(occurredAt = FIXED_INSTANT) {
  return {
    tenantId: TENANT,
    actor: { type: "USER" as const, id: USER },
    occurredAt,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API" as const,
    configurationVersionId: CONFIGURATION,
  };
}

function at(millisecondsAfterIssue: number): Date {
  return new Date(FIXED_INSTANT.valueOf() + millisecondsAfterIssue);
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("session lifecycle", () => {
  it("issues a one-time plaintext token while persisting only its deterministic hash", async () => {
    await withTenant(TENANT, async (sql) => {
      const issued = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      const { rows } = await sql.query<{
        token_hash: string;
        issued_at: Date;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      }>(
        `select token_hash, issued_at, idle_expires_at, absolute_expires_at
           from user_session
          where tenant_id = $1 and id = $2`,
        [TENANT, issued.id],
      );

      expect(Object.keys(issued).sort()).toEqual([
        "absoluteExpiresAt",
        "id",
        "idleExpiresAt",
        "issuedAt",
        "principal",
        "token",
      ]);
      expect(rows).toEqual([
        {
          token_hash: `sha-256:${createHash("sha256").update(issued.token).digest("hex")}`,
          issued_at: FIXED_INSTANT,
          idle_expires_at: at(SESSION_IDLE_TIMEOUT_MS),
          absolute_expires_at: at(SESSION_ABSOLUTE_LIFETIME_MS),
        },
      ]);
      expect(rows[0]?.token_hash).not.toContain(issued.token);
    });
  });

  it("INV-AUTH-004: resolves identity, slides idle expiry, and caps it at absolute expiry", async () => {
    await withTenant(TENANT, async (sql) => {
      const issued = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });

      await expect(
        resolveSession(transaction(sql), {
          tenantId: TENANT,
          token: issued.token,
          instant: at(10 * 60 * 1_000),
        }),
      ).resolves.toEqual({ type: "USER", id: USER });
      let result = await sql.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        "select idle_expires_at, absolute_expires_at from user_session where id = $1",
        [issued.id],
      );
      expect(result.rows[0]?.idle_expires_at).toEqual(at(40 * 60 * 1_000));

      await sql.query(
        `update user_session
            set idle_expires_at = absolute_expires_at,
                row_version = row_version + 1
          where tenant_id = $1 and id = $2`,
        [TENANT, issued.id],
      );
      await expect(
        resolveSession(transaction(sql), {
          tenantId: TENANT,
          token: issued.token,
          instant: at(SESSION_ABSOLUTE_LIFETIME_MS - 10 * 60 * 1_000),
        }),
      ).resolves.toEqual({ type: "USER", id: USER });
      result = await sql.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        "select idle_expires_at, absolute_expires_at from user_session where id = $1",
        [issued.id],
      );
      expect(result.rows[0]?.idle_expires_at).toEqual(result.rows[0]?.absolute_expires_at);
      expect(result.rows[0]?.absolute_expires_at).toEqual(at(SESSION_ABSOLUTE_LIFETIME_MS));
    });
  });

  it("returns the same absence for unknown, deleted, idle-expired and absolute-expired tokens", async () => {
    await withTenant(TENANT, async (sql) => {
      const idleExpired = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      const absoluteExpired = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      const revoked = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      await sql.query(
        `update user_session
            set idle_expires_at = absolute_expires_at,
                row_version = row_version + 1
          where tenant_id = $1 and id = $2`,
        [TENANT, absoluteExpired.id],
      );
      await revokeSession(transaction(sql), {
        ...auditContext(at(1_000)),
        sessionId: revoked.id,
      });

      const results = [];
      for (const input of [
        {
          tenantId: TENANT,
          token: "unknown-token",
          instant: FIXED_INSTANT,
        },
        {
          tenantId: TENANT,
          token: revoked.token,
          instant: at(1_000),
        },
        {
          tenantId: TENANT,
          token: idleExpired.token,
          instant: at(SESSION_IDLE_TIMEOUT_MS),
        },
        {
          tenantId: TENANT,
          token: absoluteExpired.token,
          instant: at(SESSION_ABSOLUTE_LIFETIME_MS),
        },
      ]) {
        results.push(await resolveSession(transaction(sql), input));
      }
      expect(results).toEqual([null, null, null, null]);
    });
  });

  it("revokes one session by deletion and emits its registered event", async () => {
    await withTenant(TENANT, async (sql) => {
      const first = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      const second = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });

      const revoked = await revokeSession(transaction(sql), {
        ...auditContext(),
        sessionId: first.id,
      });
      expect(revoked?.sessionIds).toEqual([first.id]);
      const sessions = await sql.query<{ id: string }>(
        "select id from user_session where user_id = $1 order by id",
        [USER],
      );
      expect(sessions.rows).toEqual([{ id: second.id }]);
      const events = await sql.query<{
        event_type: string;
        subject_type: string;
        subject_id: string;
        safe_before: unknown;
        safe_after: unknown;
      }>(
        `select event_type, subject_type, subject_id, safe_before, safe_after
           from audit_event
          where event_type = 'session.revoked'`,
      );
      expect(events.rows).toEqual([
        {
          event_type: "session.revoked",
          subject_type: "USER",
          subject_id: USER,
          safe_before: { sessionId: first.id },
          safe_after: null,
        },
      ]);
    });
  });

  it("revokes all sessions atomically by deleting each row and emitting one event per row", async () => {
    await withTenant(TENANT, async (sql) => {
      const sessions = [];
      for (const userAgentClass of ["browser", "mobile"]) {
        sessions.push(
          await issueSession(transaction(sql), {
            tenantId: TENANT,
            userId: USER,
            userAgentClass,
            instant: FIXED_INSTANT,
          }),
        );
      }

      const revoked = await revokeAllSessions(transaction(sql), {
        ...auditContext(),
        userId: USER,
      });
      expect([...revoked.sessionIds].sort()).toEqual(sessions.map(({ id }) => id).sort());
      const remaining = await sql.query<{ count: number }>(
        "select count(*)::int as count from user_session where user_id = $1",
        [USER],
      );
      expect(remaining.rows).toEqual([{ count: 0 }]);
      const events = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where event_type = 'session.revoked'",
      );
      expect(events.rows).toEqual([{ count: 2 }]);
    });
  });

  it("INV-AUTH-014: deactivation deletes sessions, preserves the user, and records each revocation", async () => {
    await withTenant(TENANT, async (sql) => {
      const sessions = [];
      for (const userAgentClass of ["browser", "mobile"]) {
        sessions.push(
          await issueSession(transaction(sql), {
            tenantId: TENANT,
            userId: USER,
            userAgentClass,
            instant: FIXED_INSTANT,
          }),
        );
      }

      const revoked = await deactivateUserAndRevokeSessions(transaction(sql), {
        ...auditContext(),
        userId: USER,
      });
      expect([...revoked.sessionIds].sort()).toEqual(sessions.map(({ id }) => id).sort());
      const remaining = await sql.query<{ count: number }>(
        "select count(*)::int as count from user_session where user_id = $1",
        [USER],
      );
      expect(remaining.rows).toEqual([{ count: 0 }]);
      const users = await sql.query<{ id: string; status: string; deactivated_at: Date }>(
        "select id, status, deactivated_at from app_user where id = $1",
        [USER],
      );
      expect(users.rows).toEqual([
        { id: USER, status: "DEACTIVATED", deactivated_at: FIXED_INSTANT },
      ]);
      const events = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where event_type = 'session.revoked'",
      );
      expect(events.rows).toEqual([{ count: 2 }]);
      await expect(
        resolveSession(transaction(sql), {
          tenantId: TENANT,
          token: sessions[0]!.token,
          instant: at(1_000),
        }),
      ).resolves.toBeNull();
    });
  });

  it("INV-AUTH-014: re-reads principal status instead of trusting the issued session", async () => {
    await withTenant(TENANT, async (sql) => {
      const issued = await issueSession(transaction(sql), {
        tenantId: TENANT,
        userId: USER,
        userAgentClass: "browser",
        instant: FIXED_INSTANT,
      });
      await sql.query(
        `update app_user
            set status = 'INVITED', row_version = row_version + 1
          where tenant_id = $1 and id = $2`,
        [TENANT, USER],
      );

      await expect(
        resolveSession(transaction(sql), {
          tenantId: TENANT,
          token: issued.token,
          instant: at(1_000),
        }),
      ).resolves.toBeNull();
      const sessions = await sql.query<{ count: number }>(
        "select count(*)::int as count from user_session where id = $1",
        [issued.id],
      );
      expect(sessions.rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-TEN-001 / INV-TEN-002: another tenant's valid token is indistinguishable from unknown", async () => {
    await withTenant(OTHER_TENANT, async (sql) => {
      await expect(
        resolveSession(transaction(sql), {
          tenantId: OTHER_TENANT,
          token: otherTenantToken,
          instant: at(1_000),
        }),
      ).resolves.toEqual({ type: "USER", id: OTHER_USER });
    });
    await withTenant(TENANT, async (sql) => {
      const otherTenant = await resolveSession(transaction(sql), {
        tenantId: TENANT,
        token: otherTenantToken,
        instant: at(1_000),
      });
      const unknown = await resolveSession(transaction(sql), {
        tenantId: TENANT,
        token: "unknown-token",
        instant: at(1_000),
      });
      expect(otherTenant).toBeNull();
      expect(otherTenant).toBe(unknown);
    });
  });

  it("INV-AUD-007: verifies PASSWORD credentials through the port without a ledger event", async () => {
    const verifier: PasswordVerifier = {
      async hash(secret) {
        return { secretHash: `fake:${secret}`, params: { algorithm: "fake" } };
      },
      async verify(secret, passwordHash) {
        return passwordHash.secretHash === `fake:${secret}`;
      },
    };
    await withTenant(TENANT, async (sql) => {
      await sql.query(
        `insert into user_credential (tenant_id, user_id, kind, secret_hash, params)
         values ($1, $2, 'PASSWORD', $3, $4)`,
        [TENANT, USER, "fake:correct", { algorithm: "fake" }],
      );

      await expect(
        verifyPasswordCredential(transaction(sql), verifier, {
          tenantId: TENANT,
          contactEmail: "a-session@example.test",
          password: "correct",
        }),
      ).resolves.toEqual({ type: "USER", id: USER });
      await expect(
        verifyPasswordCredential(transaction(sql), verifier, {
          tenantId: TENANT,
          contactEmail: "a-session@example.test",
          password: "incorrect",
        }),
      ).resolves.toBeNull();
      const events = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event",
      );
      expect(events.rows).toEqual([{ count: 0 }]);
    });
  });
});
