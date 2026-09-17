import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseMandatedAuthority,
  parseSeparationOfDutiesRules,
  parseWorkflowStages,
} from "../../domain/src/index.js";
import { withAppRole, withTenant } from "@policyoffice/testing";
import {
  buildFixtureSet,
  loadFixtureSet,
  loadReferenceData,
  REFERENCE_ENUM_VALUES,
  removeFixtureSetForTests,
} from "./fixtures.js";
import {
  CONSTRAINT_COMMENT_QUERY,
  constraintCommentProblems,
  type ConstraintCommentRow,
} from "./constraint-comments.js";

const fixture = buildFixtureSet("test");
const developmentFixture = buildFixtureSet("development");
const TENANT_A = fixture.tenants[0]?.tenant.id ?? "";
const TENANT_B = fixture.tenants[1]?.tenant.id ?? "";
const DEVELOPMENT_TENANT = developmentFixture.tenants[0]?.tenant.id ?? "";

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function tenantTables(): Promise<string[]> {
  const { rows } = await withAppRole((sql) =>
    sql.query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and exists (
           select 1
             from pg_attribute a
            where a.attrelid = c.oid
              and a.attname = 'tenant_id'
              and a.attnum > 0
              and not a.attisdropped
         )
       order by c.relname
    `),
  );
  return rows.map((row) => row.table_name);
}

async function tenantSnapshot(tenantId: string): Promise<Record<string, string>> {
  const tables = await tenantTables();
  return withTenant(tenantId, async (sql) => {
    const snapshot: Record<string, string> = {};
    for (const table of tables) {
      const { rows } = await sql.query<{ snapshot: string }>(
        `select coalesce(
           jsonb_agg(to_jsonb(fixture_row) order by to_jsonb(fixture_row)::text),
           '[]'::jsonb
         )::text as snapshot
         from ${quotedIdentifier(table)} as fixture_row`,
      );
      snapshot[table] = rows[0]?.snapshot ?? "[]";
    }
    return snapshot;
  });
}

beforeAll(async () => {
  await removeFixtureSetForTests("development");
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("development");
  await removeFixtureSetForTests("test");
});

describe("reference, development and test fixtures", () => {
  it("loads every migration-owned reference enum exactly as declared", async () => {
    expect(await loadReferenceData()).toEqual([]);
    const { rows } = await withAppRole((sql) =>
      sql.query<{ enum_name: string; values: string[] }>(`
        select typ.typname as enum_name,
               array_agg(en.enumlabel::text order by en.enumsortorder)::text[] as values
          from pg_type typ
          join pg_enum en on en.enumtypid = typ.oid
          join pg_namespace n on n.oid = typ.typnamespace
         where n.nspname = 'public'
         group by typ.typname
         order by typ.typname
      `),
    );
    expect(Object.fromEntries(rows.map((row) => [row.enum_name, row.values]))).toEqual(
      REFERENCE_ENUM_VALUES,
    );
  });

  it("loads the development fixture idempotently with exactly one legal entity", async () => {
    await loadFixtureSet("development");
    const before = await tenantSnapshot(DEVELOPMENT_TENANT);
    await loadFixtureSet("development");
    const after = await tenantSnapshot(DEVELOPMENT_TENANT);
    expect(after).toEqual(before);

    await withTenant(DEVELOPMENT_TENANT, async (sql) => {
      const entities = await sql.query<{ count: number }>(
        "select count(*)::int as count from legal_entity",
      );
      const users = await sql.query<{ count: number }>(
        "select count(*)::int as count from app_user",
      );
      const groups = await sql.query<{ count: number }>(
        "select count(*)::int as count from user_group",
      );
      expect(entities.rows).toEqual([{ count: 1 }]);
      expect(users.rows[0]?.count).toBeGreaterThanOrEqual(3);
      expect(groups.rows[0]?.count).toBeGreaterThanOrEqual(2);
    });
  });

  it("uses only migration_role for tenant roots and app_role for tenant-owned rows", async () => {
    const result = await loadFixtureSet("test");
    expect(result.executionRoles).toEqual(["migration_role", "app_role"]);
    expect(result.tenantIds).toEqual([TENANT_A, TENANT_B]);
  });

  it("INV-AUD-005: keeps a real configuration transition as the only complete audit history", async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await withTenant(tenantId, async (sql) => {
        const { rows } = await sql.query<{
          event_type: string;
          actor_type: string;
          actor_id: string;
          subject_type: string;
          subject_id: string;
          occurred_at: Date;
          correlation_id: string;
          source_channel: string;
          safe_before: unknown;
          safe_after: unknown;
          configuration_version_id: string;
        }>(`
          select event_type, actor_type, actor_id, subject_type, subject_id,
                 occurred_at, correlation_id, source_channel, safe_before, safe_after,
                 configuration_version_id
            from audit_event
           order by sequence
        `);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          event_type: "configuration.changed",
          actor_type: "USER",
          subject_type: "CONFIGURATION_VERSION",
          occurred_at: new Date("2026-01-01T00:00:00.000Z"),
          source_channel: "IMPORT",
          safe_before: null,
        });
        expect(rows[0]?.actor_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(rows[0]?.subject_id).toBe(rows[0]?.configuration_version_id);
        expect(rows[0]?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(rows[0]?.safe_after).toMatchObject({ sequence: 1, weakening: false });
      });
    }
  });

  it("discovers every tenant-owned table and requires both test tenants to populate it", async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(17);
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await withTenant(tenantId, async (sql) => {
        for (const table of tables) {
          const { rows } = await sql.query<{ count: number }>(
            `select count(*)::int as count from ${quotedIdentifier(table)}`,
          );
          expect(rows[0]?.count, `${table} for ${tenantId}`).toBeGreaterThan(0);
        }
      });
    }
  });

  it("INV-APR-010 / INV-APR-020: seeds published templates and valid type mandates", async () => {
    for (const item of fixture.tenants) {
      await withTenant(item.tenant.id, async (sql) => {
        const activeParticipants = {
          userIds: new Set(item.users.map((user) => user.id)),
          governanceBodyIds: new Set([item.governanceBody.id]),
        };
        const { rows: versions } = await sql.query<{
          template_id: string;
          active_version_id: string;
          version_id: string;
          stages: unknown;
          separation_of_duties_rules: unknown;
          published_at: Date;
          published_by: string;
        }>(`
          select template.id as template_id,
                 template.active_version_id,
                 version.id as version_id,
                 version.stages,
                 version.separation_of_duties_rules,
                 version.published_at,
                 version.published_by
            from workflow_template template
            join workflow_template_version version
              on version.tenant_id = template.tenant_id
             and version.id = template.active_version_id
             and version.workflow_template_id = template.id
        `);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({
          template_id: item.workflowTemplate.id,
          active_version_id: item.workflowTemplate.versionId,
          version_id: item.workflowTemplate.versionId,
          published_at: new Date(fixture.createdAt),
          published_by: item.workflowTemplate.publishedBy,
        });
        parseWorkflowStages(versions[0]?.stages, activeParticipants);
        parseSeparationOfDutiesRules(versions[0]?.separation_of_duties_rules);

        const { rows: documentTypes } = await sql.query<{
          default_workflow_template_id: string;
          mandated_authority: unknown;
        }>(
          `select default_workflow_template_id, mandated_authority
             from document_type
            order by rank`,
        );
        expect(documentTypes).toHaveLength(item.documentTypes.length);
        for (const documentType of documentTypes) {
          expect(documentType.default_workflow_template_id).toBe(item.workflowTemplate.id);
          parseMandatedAuthority(documentType.mandated_authority, activeParticipants);
        }
      });
    }
  });

  it("discovers every public constraint and requires an invariant comment or documented exception", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<ConstraintCommentRow>(CONSTRAINT_COMMENT_QUERY),
    );

    expect(rows.length).toBeGreaterThan(150);
    expect(constraintCommentProblems(rows)).toEqual([]);
  });

  it("INV-TEN-001: tenant A cannot see tenant B through any discovered seeded table", async () => {
    const tables = await tenantTables();
    await withTenant(TENANT_A, async (sql) => {
      for (const table of tables) {
        const { rows } = await sql.query<{ count: number }>(
          `select count(*)::int as count
             from ${quotedIdentifier(table)}
            where tenant_id = $1`,
          [TENANT_B],
        );
        expect(rows[0]?.count, table).toBe(0);
      }
    });
  });

  it("is idempotent and leaves every stored value unchanged on a second load", async () => {
    const before = {
      [TENANT_A]: await tenantSnapshot(TENANT_A),
      [TENANT_B]: await tenantSnapshot(TENANT_B),
    };
    await loadFixtureSet("test");
    const after = {
      [TENANT_A]: await tenantSnapshot(TENANT_A),
      [TENANT_B]: await tenantSnapshot(TENANT_B),
    };
    expect(after).toEqual(before);
  });

  it("INV-ORG-002: includes closed and open organisation memberships for each tenant", async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await withTenant(tenantId, async (sql) => {
        const { rows } = await sql.query<{ closed: number; open: number }>(`
          select count(*) filter (where not upper_inf(validity))::int as closed,
                 count(*) filter (where upper_inf(validity))::int as open
            from org_membership
        `);
        expect(rows).toEqual([{ closed: 1, open: 1 }]);
      });
    }
  });
});
