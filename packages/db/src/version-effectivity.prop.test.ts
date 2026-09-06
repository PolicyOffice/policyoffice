import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMigrationRole__PRIVILEGED, withTenant, type Sql } from "@policyoffice/testing";

const TENANT = "95000000-0000-0000-0000-000000000001";
const USER = "95000000-0000-0000-0001-000000000001";
const LEGAL_ENTITY = "95000000-0000-0000-0002-000000000001";
const ORG_UNIT = "95000000-0000-0000-0003-000000000001";
const CONFIGURATION = "95000000-0000-0000-0004-000000000001";
const DOCUMENT_TYPE = "95000000-0000-0000-0005-000000000001";
const CLASSIFICATION = "95000000-0000-0000-0006-000000000001";
const DOCUMENT = "95000000-0000-0000-0007-000000000001";
const VARIANT = "95000000-0000-0000-0008-000000000001";
const ORIGIN = Date.parse("2030-01-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function versionId(index: number): string {
  return `95000000-0000-0000-0009-${String(index + 1).padStart(12, "0")}`;
}

function instant(offsetHours: number): string {
  return new Date(ORIGIN + offsetHours * HOUR).toISOString();
}

async function clearTenant(sql: Sql): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
    for (const table of [
      "audit_event",
      "tenant_event_sequence",
      "document_version",
      "document_variant",
      "document",
      "org_unit",
      "legal_entity",
      "document_type",
      "information_classification",
      "configuration_version",
      "app_user",
    ]) {
      await sql.query(`delete from ${table} where tenant_id = $1`, [TENANT]);
    }
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql);
    await sql.query("delete from tenant where id = $1", [TENANT]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values ($1, 'Effectivity property tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT],
    );
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Property owner', 'effectivity-property@example.test', 'ACTIVE')`,
        [TENANT, USER],
      );
      await sql.query(
        `insert into legal_entity (tenant_id, id, legal_name, status)
         values ($1, $2, 'Property OÜ', 'ACTIVE')`,
        [TENANT, LEGAL_ENTITY],
      );
      await sql.query(
        `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
         values ($1, $2, 'Property compliance', 'PROPERTY', $3, 'ACTIVE')`,
        [TENANT, ORG_UNIT, LEGAL_ENTITY],
      );
      await sql.query(
        `insert into configuration_version (
           tenant_id, id, sequence, effective_from, changed_by, change_reason,
           weakening, payload_digest
         ) values ($1, $2, 1, '2030-01-01T00:00:00Z', $3,
                   'Property fixture', false, 'sha256:property')`,
        [TENANT, CONFIGURATION, USER],
      );
      await sql.query(
        `insert into document_type (
           tenant_id, id, code, name, rank, mandated_authority,
           default_review_rule, requires_attestation_by_default, status
         ) values ($1, $2, 'PROPERTY_POLICY', 'Property policy', 1,
                   '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
        [TENANT, DOCUMENT_TYPE],
      );
      await sql.query(
        `insert into information_classification (
           tenant_id, id, code, name, rank, handling_instructions,
           externally_disclosable, status
         ) values ($1, $2, 'PROPERTY_INTERNAL', 'Property internal', 1,
                   'Property fixture', false, 'ACTIVE')`,
        [TENANT, CLASSIFICATION],
      );
      await sql.query(
        `insert into document (
           tenant_id, id, document_code, canonical_title, document_type_id,
           owning_org_unit_id, lifecycle_status, is_governing_framework
         ) values ($1, $2, 'PROPERTY-001', 'Property policy', $3, $4, 'PLANNED', false)`,
        [TENANT, DOCUMENT, DOCUMENT_TYPE, ORG_UNIT],
      );
      await sql.query(
        `insert into document_variant
           (tenant_id, id, document_id, variant_type, status)
         values ($1, $2, $3, 'BASELINE', 'ACTIVE')`,
        [TENANT, VARIANT, DOCUMENT],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
});

afterAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql);
    await sql.query("delete from tenant where id = $1", [TENANT]);
  });
});

async function insertInterval(sql: Sql, index: number, start: number, end: number): Promise<void> {
  await sql.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
       document_type_id, title, classification_id, materiality,
       effective_from, effective_until, configuration_version_id
     ) values ($1, $2, $3, $4, 'DRAFT', $5, 'Property policy', $6,
               'MATERIAL', $7, $8, $9)`,
    [
      TENANT,
      versionId(index),
      VARIANT,
      index + 1,
      DOCUMENT_TYPE,
      CLASSIFICATION,
      instant(start),
      instant(end),
      CONFIGURATION,
    ],
  );
  for (const lifecycle of ["IN_REVIEW", "APPROVED", "PUBLISHED", "EFFECTIVE"] as const) {
    await sql.query(
      `update document_version
          set lifecycle_state = $2::version_lifecycle,
              row_version = row_version + 1
        where id = $1`,
      [versionId(index), lifecycle],
    );
  }
}

describe("document version effectivity properties", () => {
  it("INV-EFF-002: arbitrary interval attempts leave at most one version claiming any instant", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 48 }),
            duration: fc.integer({ min: 1, max: 24 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (candidates) => {
          await withTenant(TENANT, async (sql) => {
            const accepted: Array<Readonly<{ start: number; end: number }>> = [];
            for (const [index, candidate] of candidates.entries()) {
              const proposed = {
                start: candidate.start,
                end: candidate.start + candidate.duration,
              };
              const overlaps = accepted.some(
                (current) => proposed.start < current.end && current.start < proposed.end,
              );
              await sql.query(`savepoint "interval_${index}"`);
              try {
                await insertInterval(sql, index, proposed.start, proposed.end);
                expect(overlaps).toBe(false);
                accepted.push(proposed);
                await sql.query(`release savepoint "interval_${index}"`);
              } catch (error) {
                await sql.query(`rollback to savepoint "interval_${index}"`);
                await sql.query(`release savepoint "interval_${index}"`);
                expect(overlaps).toBe(true);
                expect(error).toMatchObject({
                  code: "23P01",
                  constraint: "one_effective_version_per_variant",
                });
              }
            }

            for (let point = 0; point <= 72; point += 0.5) {
              const claims = accepted.filter(
                (interval) => interval.start <= point && point < interval.end,
              );
              expect(claims.length).toBeLessThanOrEqual(1);
            }
            const { rows } = await sql.query<{ overlaps: number }>(`
              select count(*)::int as overlaps
                from document_version left_version
                join document_version right_version
                  on right_version.tenant_id = left_version.tenant_id
                 and right_version.document_variant_id = left_version.document_variant_id
                 and right_version.id > left_version.id
                 and right_version.effective_range && left_version.effective_range
            `);
            expect(rows).toEqual([{ overlaps: 0 }]);
          });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("INV-TIME-005: arbitrary consecutive half-open intervals share no boundary instant", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 15 }),
        async (durations) => {
          await withTenant(TENANT, async (sql) => {
            let start = 0;
            const boundaries: number[] = [];
            for (const [index, duration] of durations.entries()) {
              boundaries.push(start);
              await insertInterval(sql, index, start, start + duration);
              start += duration;
            }

            for (const boundary of boundaries) {
              const { rows } = await sql.query<{ count: number }>(
                `select count(*)::int as count
                   from document_version
                  where effective_range @> $1::timestamptz`,
                [instant(boundary)],
              );
              expect(rows).toEqual([{ count: 1 }]);
            }
            const after = await sql.query<{ count: number }>(
              `select count(*)::int as count
                 from document_version
                where effective_range @> $1::timestamptz`,
              [instant(start)],
            );
            expect(after.rows).toEqual([{ count: 0 }]);
          });
        },
      ),
      { numRuns: 40 },
    );
  });
});
