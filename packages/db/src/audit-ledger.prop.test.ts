import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  emitAuditEvents,
  type AuditEventInput,
  type AuditTransaction,
} from "../../domain/src/audit.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT_ID = "76000000-0000-0000-0000-000000000006";
const SUBJECT_ID = "76000000-0000-0000-0001-000000000006";
const REQUEST_ID = "76000000-0000-0000-0002-000000000006";
const CORRELATION_ID = "76000000-0000-0000-0003-000000000006";
const CONFIGURATION_ID = "76000000-0000-0000-0004-000000000006";
const CONFIGURATION_USER_ID = "76000000-0000-0000-0005-000000000006";

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function event(key: string): AuditEventInput {
  return {
    tenantId: TENANT_ID,
    eventType: "version.effective",
    eventSchemaVersion: 1,
    occurredAt: new Date("2027-01-15T09:42:17.231Z"),
    actor: { type: "SYSTEM", id: null },
    subject: { type: "DOCUMENT_VERSION", id: SUBJECT_ID },
    action: "MAKE_EFFECTIVE",
    outcome: "SUCCESS",
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    sourceChannel: "JOB",
    configurationVersionId: CONFIGURATION_ID,
    dedupeKey: `version.effective:property:${key}`,
  };
}

async function clearEvents(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT_ID]);
      await sql.query("delete from audit_event where tenant_id = $1", [TENANT_ID]);
      await sql.query("delete from tenant_event_sequence where tenant_id = $1", [TENANT_ID]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

async function clearConfigurationFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT_ID]);
      await sql.query("delete from configuration_version where tenant_id = $1", [TENANT_ID]);
      await sql.query("delete from app_user where tenant_id = $1", [TENANT_ID]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

beforeAll(async () => {
  await clearEvents();
  await clearConfigurationFixtures();
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("delete from tenant where id = $1", [TENANT_ID]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values ($1, 'Audit property tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT_ID],
    );
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT_ID]);
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Audit property user', 'audit-property@example.test', 'ACTIVE')`,
        [TENANT_ID, CONFIGURATION_USER_ID],
      );
      await sql.query(
        `insert into configuration_version (
           tenant_id, id, sequence, effective_from, changed_by, change_reason,
           weakening, payload_digest
         ) values ($1, $2, 1, $3, $4, 'Audit property fixture', false, $5)`,
        [
          TENANT_ID,
          CONFIGURATION_ID,
          "2027-01-01T00:00:00.000Z",
          CONFIGURATION_USER_ID,
          "sha256:audit-property",
        ],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
});

afterAll(async () => {
  await clearEvents();
  await clearConfigurationFixtures();
  await withMigrationRole__PRIVILEGED((sql) =>
    sql.query("delete from tenant where id = $1", [TENANT_ID]).then(() => undefined),
  );
});

describe("gapless audit sequence properties", () => {
  it("INV-AUD-009: arbitrary committed, rolled-back and batched writes remain gapless", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            commit: fc.boolean(),
            batchSize: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (operations) => {
          await clearEvents();
          let expectedCount = 0;

          for (const [operationIndex, operation] of operations.entries()) {
            await withAppRole(async (sql) => {
              await sql.query("begin");
              try {
                await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT_ID]);
                await emitAuditEvents(
                  transaction(sql),
                  Array.from({ length: operation.batchSize }, (_, eventIndex) =>
                    event(`${operationIndex}:${eventIndex}`),
                  ),
                );
                await sql.query(operation.commit ? "commit" : "rollback");
              } catch (error) {
                await sql.query("rollback");
                throw error;
              }
            });
            if (operation.commit) expectedCount += operation.batchSize;
          }

          await withTenant(TENANT_ID, async (sql) => {
            const { rows } = await sql.query<{ sequence: string }>(
              "select sequence from audit_event order by sequence",
            );
            expect(rows.map((row) => Number(row.sequence))).toEqual(
              Array.from({ length: expectedCount }, (_, index) => index + 1),
            );
          });
        },
      ),
      { numRuns: 20 },
    );
  });
});
