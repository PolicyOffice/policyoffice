import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAppRole, withTenant } from "@policyoffice/testing";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0]!;
const tenantB = fixture.tenants[1]!;
const documentA = tenantA.documents[0]!;
const documentB = tenantB.documents[0]!;
const TENANT_A = tenantA.tenant.id;
const RULE_A = documentA.applicabilityRuleId;
const OBLIGATION_A = documentA.alignmentObligationId;

const TABLE_COLUMNS = {
  alignment_obligation: [
    "tenant_id",
    "id",
    "created_at",
    "updated_at",
    "row_version",
    "subject_type",
    "subject_id",
    "source_version_id",
    "raised_at",
    "due_at",
    "reason",
    "status",
    "resolved_by",
    "resolved_at",
    "resolution_note",
    "resolving_review_case_id",
  ],
  applicability_rule: [
    "tenant_id",
    "id",
    "created_at",
    "updated_at",
    "row_version",
    "document_variant_id",
    "authorised_by_version_id",
    "effect",
    "legal_entity_ids",
    "org_unit_ids",
    "jurisdiction_ids",
    "group_ids",
    "user_ids",
    "inheritance_mode",
    "validity",
  ],
} as const;

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the applicability and alignment schema", () => {
  it("INV-APL-010 / INV-TEN-003: has the exact tenant-owned shape with no Space path", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: keyof typeof TABLE_COLUMNS;
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(
        `
        select c.relname as table_name,
               array_agg(a.attname::text order by a.attnum) filter (where a.attnum > 0) as columns,
               c.relrowsecurity as row_security,
               c.relforcerowsecurity as force_row_security,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
         where n.nspname = 'public'
           and c.relname = any($1::text[])
         group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
         order by c.relname
        `,
        [[...Object.keys(TABLE_COLUMNS)]],
      ),
    );

    expect(rows.map((row) => row.table_name)).toEqual(Object.keys(TABLE_COLUMNS));
    for (const row of rows) {
      expect(row.columns, row.table_name).toEqual(TABLE_COLUMNS[row.table_name]);
      expect(row.columns, row.table_name).not.toContain("space_id");
      expect(row.row_security, row.table_name).toBe(true);
      expect(row.force_row_security, row.table_name).toBe(true);
      expect(row.policy_count, row.table_name).toBe(1);
    }
  });

  it("INV-VER-007 / INV-TIME-005 / INV-TEN-003: documents every enforcing constraint", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string; comment: string | null }>(
        `
        select rel.relname as table_name,
               con.conname as constraint_name,
               obj_description(con.oid, 'pg_constraint') as comment
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public'
           and rel.relname = any($1::text[])
           and con.contype in ('p', 'f', 'u', 'c', 'x')
         order by rel.relname, con.conname
        `,
        [[...Object.keys(TABLE_COLUMNS)]],
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.filter((row) => !row.comment?.includes("INV-"))).toEqual([]);
  });

  it("INV-TEN-003 / INV-VER-007: keeps authorising provenance nullable and tenant-qualified with RESTRICT", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ is_nullable: string; delete_action: string; definition: string }>(`
        select column_shape.is_nullable,
               constraint_shape.confdeltype as delete_action,
               pg_get_constraintdef(constraint_shape.oid) as definition
          from information_schema.columns column_shape
          join pg_class rel on rel.relname = column_shape.table_name
          join pg_namespace namespace
            on namespace.oid = rel.relnamespace
           and namespace.nspname = column_shape.table_schema
          join pg_constraint constraint_shape
            on constraint_shape.conrelid = rel.oid
           and constraint_shape.conname = 'applicability_rule_authorised_version_fk'
         where column_shape.table_schema = 'public'
           and column_shape.table_name = 'applicability_rule'
           and column_shape.column_name = 'authorised_by_version_id'
      `),
    );
    expect(rows).toEqual([
      {
        is_nullable: "YES",
        delete_action: "r",
        definition: expect.stringMatching(
          /FOREIGN KEY \(tenant_id, authorised_by_version_id\).*ON DELETE RESTRICT/,
        ),
      },
    ]);
  });

  it("INV-APL-008 / INV-VER-007: denies app_role deletion and truncation", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        can_delete: boolean;
        can_truncate: boolean;
      }>(`
        select table_name,
               has_table_privilege('app_role', table_name, 'DELETE') as can_delete,
               has_table_privilege('app_role', table_name, 'TRUNCATE') as can_truncate
          from unnest(array['alignment_obligation', 'applicability_rule']) as tables(table_name)
         order by table_name
      `),
    );
    expect(rows).toEqual([
      { table_name: "alignment_obligation", can_delete: false, can_truncate: false },
      { table_name: "applicability_rule", can_delete: false, can_truncate: false },
    ]);

    await expect(
      withTenant(TENANT_A, (sql) =>
        sql.query("delete from applicability_rule where id = $1", [RULE_A]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(TENANT_A, (sql) => sql.query("truncate table alignment_obligation")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-AUTH-017: no database authorization structure references either table", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; target_table: string }>(`
        select rel.relname as table_name, target.relname as target_table
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_class target on target.oid = con.confrelid
         where con.contype = 'f'
           and target.relname in ('applicability_rule', 'alignment_obligation')
           and rel.relname ~ '(access|grant|role|permission|capability|authorization)'
      `),
    );
    expect(rows).toEqual([]);
  });
});

describe("tenant-contained applicability references", () => {
  it.each([
    ["legal_entity_ids", tenantB.legalEntity.id, "applicability_rule_legal_entity_tenant_fk"],
    ["org_unit_ids", tenantB.orgUnit.id, "applicability_rule_org_unit_tenant_fk"],
    ["jurisdiction_ids", tenantB.jurisdiction.id, "applicability_rule_jurisdiction_tenant_fk"],
    ["group_ids", tenantB.groups[0]!.id, "applicability_rule_group_tenant_fk"],
    ["user_ids", tenantB.users[0]!.id, "applicability_rule_user_tenant_fk"],
  ])(
    "INV-TEN-003: rejects a cross-tenant UUID in %s",
    async (column, crossTenantId, constraint) => {
      await expect(
        withTenant(TENANT_A, (sql) =>
          sql.query(
            `insert into applicability_rule (
               tenant_id, document_variant_id, authorised_by_version_id, effect,
               inheritance_mode, validity, ${column}
             ) values (
               $1, $2, $3, 'INCLUDE', 'DEFAULT',
               tstzrange('2026-01-01', null, '[)'), array[$4]::uuid[]
             )`,
            [TENANT_A, documentA.baselineVariantId, documentA.draftVersionId, crossTenantId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23503", constraint });
    },
  );

  it("INV-TEN-003 / INV-VER-007: rejects a cross-tenant authorising version", async () => {
    await expect(
      withTenant(TENANT_A, (sql) =>
        sql.query(
          `insert into applicability_rule (
             tenant_id, document_variant_id, authorised_by_version_id, effect,
             inheritance_mode, validity
           ) values (
             $1, $2, $3, 'INCLUDE', 'DEFAULT',
             tstzrange('2026-01-01', null, '[)')
           )`,
          [TENANT_A, documentA.baselineVariantId, documentB.draftVersionId],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "applicability_rule_authorised_version_fk",
    });
  });

  it("INV-TEN-003 / INV-APL-008: rejects a cross-tenant polymorphic alignment subject", async () => {
    await expect(
      withTenant(TENANT_A, (sql) =>
        sql.query(
          `insert into alignment_obligation (
             tenant_id, subject_type, subject_id, source_version_id,
             raised_at, reason, status
           ) values ($1, 'DOCUMENT_VARIANT', $2, $3, now(), 'Cross tenant', 'OPEN')`,
          [TENANT_A, documentB.baselineVariantId, documentA.draftVersionId],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "alignment_obligation_subject_tenant_fk",
    });
  });

  it("INV-TEN-001 / INV-TEN-003: another tenant's rule and obligation are indistinguishable from absent", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const rules = await sql.query<{ count: number }>(
        "select count(*)::int as count from applicability_rule where id = $1",
        [documentB.applicabilityRuleId],
      );
      const obligations = await sql.query<{ count: number }>(
        "select count(*)::int as count from alignment_obligation where id = $1",
        [documentB.alignmentObligationId],
      );
      expect(rules.rows).toEqual([{ count: 0 }]);
      expect(obligations.rows).toEqual([{ count: 0 }]);
    });
  });
});

describe("applicability provenance and history", () => {
  it("INV-VER-007: submission captures the authorising version on every draft rule", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const ruleId = "a1000000-0000-0000-0001-000000000001";
      await sql.query(
        `insert into applicability_rule (
           tenant_id, id, document_variant_id, authorised_by_version_id, effect,
           inheritance_mode, validity
         ) values (
           $1, $2, $3, null, 'INCLUDE', 'DEFAULT',
           tstzrange('2026-01-01', null, '[)')
         )`,
        [TENANT_A, ruleId, documentA.baselineVariantId],
      );
      const draft = await sql.query<{ authorised_by_version_id: string | null }>(
        "select authorised_by_version_id from applicability_rule where id = $1",
        [ruleId],
      );
      expect(draft.rows).toEqual([{ authorised_by_version_id: null }]);

      await sql.query(
        `update document_version
            set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
          where id = $1`,
        [documentA.draftVersionId],
      );
      const submitted = await sql.query<{
        authorised_by_version_id: string;
        row_version: number;
      }>("select authorised_by_version_id, row_version from applicability_rule where id = $1", [
        ruleId,
      ]);
      expect(submitted.rows).toEqual([
        { authorised_by_version_id: documentA.draftVersionId, row_version: 2 },
      ]);

      await expect(
        sql.query(
          `insert into applicability_rule (
             tenant_id, document_variant_id, authorised_by_version_id, effect,
             inheritance_mode, validity
           ) values (
             $1, $2, null, 'INCLUDE', 'DEFAULT',
             tstzrange('2027-01-01', null, '[)')
           )`,
          [TENANT_A, documentA.baselineVariantId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "applicability_rule_authority_required",
      });
    });
  });

  it("INV-VER-007: rejects provenance from a version of another variant", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const otherVariant = "a1000000-0000-0000-0002-000000000001";
      const otherVersion = "a1000000-0000-0000-0002-000000000002";
      await sql.query(
        `insert into document_variant (
           tenant_id, id, document_id, variant_type, source_variant_id, status
         ) values ($1, $2, $3, 'SUPPLEMENT', $4, 'ACTIVE')`,
        [TENANT_A, otherVariant, documentA.id, documentA.baselineVariantId],
      );
      await sql.query(
        `insert into document_version (
           tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
           document_type_id, title, classification_id, materiality,
           change_summary, configuration_version_id
         ) values ($1, $2, $3, 1, 'DRAFT', $4, 'Supplement', $5,
                   'MATERIAL', 'Supplement draft', $6)`,
        [
          TENANT_A,
          otherVersion,
          otherVariant,
          documentA.documentTypeId,
          tenantA.classifications[0]!.id,
          tenantA.configuration.id,
        ],
      );

      await expect(
        sql.query(
          `insert into applicability_rule (
             tenant_id, document_variant_id, authorised_by_version_id, effect,
             inheritance_mode, validity
           ) values (
             $1, $2, $3, 'INCLUDE', 'DEFAULT',
             tstzrange('2026-01-01', null, '[)')
           )`,
          [TENANT_A, documentA.baselineVariantId, otherVersion],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "applicability_rule_authority_variant",
      });
    });
  });

  it("INV-VER-007: freezes approved rule facts while permitting close-and-append correction", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `update applicability_rule
            set inheritance_mode = 'LOCAL_ONLY', row_version = row_version + 1
          where id = $1`,
        [RULE_A],
      );
      await sql.query(
        `update document_version
            set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
          where id = $1`,
        [documentA.draftVersionId],
      );
      await sql.query(
        `update document_version
            set lifecycle_state = 'APPROVED', row_version = row_version + 1
          where id = $1`,
        [documentA.draftVersionId],
      );

      await sql.query("savepoint before_approved_rewrite");
      try {
        await sql.query(
          `update applicability_rule
              set effect = 'EXCLUDE', row_version = row_version + 1
            where id = $1`,
          [RULE_A],
        );
        expect.unreachable("approved applicability unexpectedly changed");
      } catch (error) {
        expect(error).toMatchObject({
          code: "55000",
          constraint: "applicability_rule_approved_immutable",
        });
        await sql.query("rollback to savepoint before_approved_rewrite");
      }

      await sql.query("savepoint before_approved_start_change");
      try {
        await sql.query(
          `update applicability_rule
              set validity = tstzrange('2026-02-01', null, '[)'),
                  row_version = row_version + 1
            where id = $1`,
          [RULE_A],
        );
        expect.unreachable("approved applicability interval start unexpectedly changed");
      } catch (error) {
        expect(error).toMatchObject({
          code: "55000",
          constraint: "applicability_rule_approved_immutable",
        });
        await sql.query("rollback to savepoint before_approved_start_change");
      }

      await sql.query(
        `update applicability_rule
            set validity = tstzrange(lower(validity), '2027-01-01', '[)'),
                row_version = row_version + 1
          where id = $1`,
        [RULE_A],
      );
      await sql.query(
        `update document_version
            set lifecycle_state = 'CANCELLED', row_version = row_version + 1
          where id = $1`,
        [documentA.draftVersionId],
      );

      const correctionVersion = "a1000000-0000-0000-0003-000000000001";
      const correctionRule = "a1000000-0000-0000-0003-000000000002";
      await sql.query(
        `insert into document_version (
           tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
           document_type_id, title, classification_id, materiality,
           change_summary, configuration_version_id
         ) values ($1, $2, $3, 2, 'DRAFT', $4, 'Corrected policy', $5,
                   'MATERIAL', 'Correct applicability', $6)`,
        [
          TENANT_A,
          correctionVersion,
          documentA.baselineVariantId,
          documentA.documentTypeId,
          tenantA.classifications[0]!.id,
          tenantA.configuration.id,
        ],
      );
      await sql.query(
        `insert into applicability_rule (
           tenant_id, id, document_variant_id, authorised_by_version_id, effect,
           legal_entity_ids, inheritance_mode, validity
         ) values (
           $1, $2, $3, $4, 'INCLUDE', array[$5]::uuid[], 'DEFAULT',
           tstzrange('2027-01-01', null, '[)')
         )`,
        [
          TENANT_A,
          correctionRule,
          documentA.baselineVariantId,
          correctionVersion,
          tenantA.legalEntity.id,
        ],
      );

      const history = await sql.query<{
        id: string;
        authorised_by_version_id: string;
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `select id, authorised_by_version_id,
                lower(validity) as valid_from, upper(validity) as valid_until
           from applicability_rule
          where id = any($1::uuid[])
          order by lower(validity)`,
        [[RULE_A, correctionRule]],
      );
      expect(history.rows).toEqual([
        {
          id: RULE_A,
          authorised_by_version_id: documentA.draftVersionId,
          valid_from: new Date("2026-01-01T00:00:00.000Z"),
          valid_until: new Date("2027-01-01T00:00:00.000Z"),
        },
        {
          id: correctionRule,
          authorised_by_version_id: correctionVersion,
          valid_from: new Date("2027-01-01T00:00:00.000Z"),
          valid_until: null,
        },
      ]);

      await sql.query("savepoint before_ended_rewrite");
      try {
        await sql.query(
          `update applicability_rule
              set inheritance_mode = 'MANDATORY', row_version = row_version + 1
            where id = $1`,
          [RULE_A],
        );
        expect.unreachable("ended applicability unexpectedly changed");
      } catch (error) {
        expect(error).toMatchObject({
          code: "55000",
          constraint: "applicability_rule_history_immutable",
        });
        await sql.query("rollback to savepoint before_ended_rewrite");
      }
    });
  });

  it("INV-TIME-005: enforces half-open rule intervals and permits exact adjacency", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await expect(
        sql.query(
          `insert into applicability_rule (
             tenant_id, document_variant_id, authorised_by_version_id, effect,
             inheritance_mode, validity
           ) values (
             $1, $2, $3, 'INCLUDE', 'DEFAULT',
             tstzrange('2027-01-01', '2028-01-01', '[]')
           )`,
          [TENANT_A, documentA.baselineVariantId, documentA.draftVersionId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "applicability_rule_validity_half_open",
      });
    });

    await withTenant(TENANT_A, async (sql) => {
      const first = "a1000000-0000-0000-0004-000000000001";
      const second = "a1000000-0000-0000-0004-000000000002";
      await sql.query(
        `insert into applicability_rule (
           tenant_id, id, document_variant_id, authorised_by_version_id, effect,
           inheritance_mode, validity
         ) values
           ($1, $2, $4, $5, 'INCLUDE', 'DEFAULT',
            tstzrange('2027-01-01', '2028-01-01', '[)')),
           ($1, $3, $4, $5, 'INCLUDE', 'DEFAULT',
            tstzrange('2028-01-01', '2029-01-01', '[)'))`,
        [TENANT_A, first, second, documentA.baselineVariantId, documentA.draftVersionId],
      );
      const { rows } = await sql.query<{ overlaps: boolean }>(
        `select first.validity && second.validity as overlaps
           from applicability_rule first
           join applicability_rule second on second.id = $2
          where first.id = $1`,
        [first, second],
      );
      expect(rows).toEqual([{ overlaps: false }]);
    });
  });
});

describe("alignment obligations", () => {
  it("INV-APL-013: an overdue deadline neither resolves nor blocks or invalidates versions", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `update alignment_obligation
            set due_at = '2026-02-01T00:00:00Z', row_version = row_version + 1
          where id = $1`,
        [OBLIGATION_A],
      );
      await sql.query(
        `update document_version
            set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
          where id = $1`,
        [documentA.draftVersionId],
      );
      const { rows } = await sql.query<{
        obligation_status: string;
        source_version_state: string;
        downstream_variant_status: string;
      }>(
        `select obligation.status as obligation_status,
                version.lifecycle_state as source_version_state,
                variant.status as downstream_variant_status
           from alignment_obligation obligation
           join document_version version
             on version.tenant_id = obligation.tenant_id
            and version.id = obligation.source_version_id
           join document_variant variant
             on variant.tenant_id = obligation.tenant_id
            and variant.id = obligation.subject_id
          where obligation.id = $1
            and obligation.due_at < '2027-01-01T00:00:00Z'`,
        [OBLIGATION_A],
      );
      expect(rows).toEqual([
        {
          obligation_status: "OPEN",
          source_version_state: "IN_REVIEW",
          downstream_variant_status: "ACTIVE",
        },
      ]);
    });
  });

  it("INV-APL-008: cannot resolve without recorded action and attribution", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query("savepoint before_unattributed_resolution");
      try {
        await sql.query(
          `update alignment_obligation
              set status = 'RESOLVED', row_version = row_version + 1
            where id = $1`,
          [OBLIGATION_A],
        );
        expect.unreachable("an unattributed alignment resolution unexpectedly succeeded");
      } catch (error) {
        expect(error).toMatchObject({
          code: "23514",
          constraint: "alignment_obligation_resolution_consistent",
        });
        await sql.query("rollback to savepoint before_unattributed_resolution");
      }

      const { rows } = await sql.query<{
        status: string;
        resolved_by: string;
        resolution_note: string;
      }>(
        `update alignment_obligation
            set status = 'RESOLVED',
                resolved_by = $2,
                resolved_at = '2027-01-01T00:00:00Z',
                resolution_note = 'Reviewed; no local policy change is required.',
                row_version = row_version + 1
          where id = $1
        returning status, resolved_by, resolution_note`,
        [OBLIGATION_A, tenantA.users[0]!.id],
      );
      expect(rows).toEqual([
        {
          status: "RESOLVED",
          resolved_by: tenantA.users[0]!.id,
          resolution_note: "Reviewed; no local policy change is required.",
        },
      ]);
    });
  });
});
