import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DocumentConcurrencyError,
  DocumentNotFoundError,
  changeDocumentMetadata,
  changeDocumentOwner,
  changeDocumentType,
  createDocument,
  listDocumentRegister,
  retireDocument,
  type AuditTransaction,
  type CreateDocumentInput,
} from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "91000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "92000000-0000-0000-0000-000000000002";
const USER = "91000000-0000-0000-0001-000000000001";
const SECOND_USER = "91000000-0000-0000-0001-000000000002";
const OTHER_USER = "92000000-0000-0000-0001-000000000001";
const LEGAL_ENTITY = "91000000-0000-0000-0002-000000000001";
const OTHER_LEGAL_ENTITY = "92000000-0000-0000-0002-000000000001";
const ORG_UNIT = "91000000-0000-0000-0003-000000000001";
const OTHER_ORG_UNIT = "92000000-0000-0000-0003-000000000001";
const SPACE = "91000000-0000-0000-0004-000000000001";
const OTHER_SPACE = "92000000-0000-0000-0004-000000000001";
const CONFIGURATION = "91000000-0000-0000-0005-000000000001";
const OTHER_CONFIGURATION = "92000000-0000-0000-0005-000000000001";
const DOCUMENT_TYPE = "91000000-0000-0000-0006-000000000001";
const SECOND_DOCUMENT_TYPE = "91000000-0000-0000-0006-000000000002";
const OTHER_DOCUMENT_TYPE = "92000000-0000-0000-0006-000000000001";
const EXISTING_DOCUMENT = "91000000-0000-0000-0007-000000000001";
const EXISTING_BASELINE = "91000000-0000-0000-0008-000000000001";
const OTHER_DOCUMENT = "92000000-0000-0000-0007-000000000001";
const OTHER_BASELINE = "92000000-0000-0000-0008-000000000001";
const DOCUMENT = "91000000-0000-0000-0009-000000000001";
const BASELINE = "91000000-0000-0000-0010-000000000001";
const REQUEST = "91000000-0000-0000-0011-000000000001";
const CORRELATION = "91000000-0000-0000-0012-000000000001";
const FIXED_INSTANT = new Date("2027-02-01T10:00:00.000Z");

interface TenantSeed {
  tenantId: string;
  userId: string;
  legalEntityId: string;
  orgUnitId: string;
  spaceId: string;
  configurationId: string;
  documentTypeId: string;
  documentId: string;
  baselineId: string;
  label: string;
}

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function createInput(overrides: Partial<CreateDocumentInput> = {}): CreateDocumentInput {
  return {
    tenantId: TENANT,
    documentId: DOCUMENT,
    baselineVariantId: BASELINE,
    documentCode: "NEW-POL-001",
    canonicalTitle: "New Policy",
    documentTypeId: DOCUMENT_TYPE,
    ownerUserId: null,
    owningOrgUnitId: ORG_UNIT,
    spaceId: SPACE,
    isGoverningFramework: false,
    actor: { type: "USER", id: USER },
    configurationVersionId: CONFIGURATION,
    occurredAt: FIXED_INSTANT,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API",
    ...overrides,
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
      "tenant_event_sequence",
      "document_variant",
      "document",
      "space",
      "org_unit",
      "legal_entity",
      "document_type",
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

async function seedTenant(seed: TenantSeed): Promise<void> {
  await inCommittedTenant(seed.tenantId, async (sql) => {
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [
        seed.tenantId,
        seed.userId,
        `${seed.label} document owner`,
        `${seed.label.toLowerCase()}-document@example.test`,
      ],
    );
    if (seed.tenantId === TENANT) {
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Second owner', 'second-document@example.test', 'ACTIVE')`,
        [seed.tenantId, SECOND_USER],
      );
    }
    await sql.query(
      `insert into legal_entity (
         tenant_id, id, legal_name, country_of_registration, status
       ) values ($1, $2, $3, 'EE', 'ACTIVE')`,
      [seed.tenantId, seed.legalEntityId, `${seed.label} OÜ`],
    );
    await sql.query(
      `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
       values ($1, $2, 'Compliance', $3, $4, 'ACTIVE')`,
      [seed.tenantId, seed.orgUnitId, `COMPLIANCE_${seed.label}`, seed.legalEntityId],
    );
    await sql.query(
      `insert into space (tenant_id, id, name, code, owning_org_unit_id, status)
       values ($1, $2, 'Policies', $3, $4, 'ACTIVE')`,
      [seed.tenantId, seed.spaceId, `POLICIES_${seed.label}`, seed.orgUnitId],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, $3, $4, 'Initial document test configuration', false, $5)`,
      [
        seed.tenantId,
        seed.configurationId,
        FIXED_INSTANT.toISOString(),
        seed.userId,
        `sha256:${seed.label.toLowerCase()}-document-configuration`,
      ],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority, default_review_rule,
         requires_attestation_by_default, status
       ) values ($1, $2, $3, 'Policy', 10, '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
      [seed.tenantId, seed.documentTypeId, `POLICY_${seed.label}`],
    );
    if (seed.tenantId === TENANT) {
      await sql.query(
        `insert into document_type (
           tenant_id, id, code, name, rank, mandated_authority, default_review_rule,
           requires_attestation_by_default, status
         ) values ($1, $2, 'PROCEDURE_A', 'Procedure', 20,
                   '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
        [seed.tenantId, SECOND_DOCUMENT_TYPE],
      );
    }
    await sql.query(
      `insert into document (
         tenant_id, id, document_code, canonical_title, document_type_id,
         owner_user_id, owning_org_unit_id, space_id, lifecycle_status,
         is_governing_framework
       ) values ($1, $2, 'SHARED-CODE', $3, $4, $5, $6, $7, 'PLANNED', false)`,
      [
        seed.tenantId,
        seed.documentId,
        `${seed.label} existing policy`,
        seed.documentTypeId,
        seed.userId,
        seed.orgUnitId,
        seed.spaceId,
      ],
    );
    await sql.query(
      `insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, locale, status
       ) values ($1, $2, $3, 'BASELINE', null, null, 'ACTIVE')`,
      [seed.tenantId, seed.baselineId, seed.documentId],
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
         ($1, 'Document tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other document tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
  });
  await seedTenant({
    tenantId: TENANT,
    userId: USER,
    legalEntityId: LEGAL_ENTITY,
    orgUnitId: ORG_UNIT,
    spaceId: SPACE,
    configurationId: CONFIGURATION,
    documentTypeId: DOCUMENT_TYPE,
    documentId: EXISTING_DOCUMENT,
    baselineId: EXISTING_BASELINE,
    label: "A",
  });
  await seedTenant({
    tenantId: OTHER_TENANT,
    userId: OTHER_USER,
    legalEntityId: OTHER_LEGAL_ENTITY,
    orgUnitId: OTHER_ORG_UNIT,
    spaceId: OTHER_SPACE,
    configurationId: OTHER_CONFIGURATION,
    documentTypeId: OTHER_DOCUMENT_TYPE,
    documentId: OTHER_DOCUMENT,
    baselineId: OTHER_BASELINE,
    label: "B",
  });
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
  });
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("document and variant identity", () => {
  it("INV-DOC-001 / INV-DOC-005 / INV-DOC-006 / INV-AUTH-017 / INV-TEN-003: installs the exact tenant-owned register shape", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(
        `select c.relname as table_name,
                array_agg(a.attname::text order by a.attname) filter (where a.attnum > 0) as columns,
                c.relrowsecurity as row_security,
                c.relforcerowsecurity as force_row_security,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
          where n.nspname = 'public' and c.relname = any($1::text[])
          group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
          order by c.relname`,
        [["document", "document_variant"]],
      ),
    );
    expect(rows.map((row) => row.table_name)).toEqual(["document", "document_variant"]);
    for (const row of rows) {
      expect(row.row_security).toBe(true);
      expect(row.force_row_security).toBe(true);
      expect(row.policy_count).toBe(1);
    }
    expect(rows.find((row) => row.table_name === "document")?.columns).toEqual([
      "canonical_title",
      "created_at",
      "document_code",
      "document_type_id",
      "id",
      "is_governing_framework",
      "lifecycle_status",
      "owner_user_id",
      "owning_org_unit_id",
      "retired_at",
      "retirement_reason",
      "row_version",
      "space_id",
      "tenant_id",
      "updated_at",
    ]);
    expect(rows.find((row) => row.table_name === "document_variant")?.columns).toEqual([
      "created_at",
      "document_id",
      "id",
      "locale",
      "row_version",
      "source_variant_id",
      "status",
      "tenant_id",
      "updated_at",
      "variant_type",
    ]);

    const columns = await withAppRole((sql) =>
      sql.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'document'
            and column_name = any($1::text[])
          order by column_name`,
        [["document_type_id", "owner_user_id", "owning_org_unit_id", "space_id"]],
      ),
    );
    expect(
      Object.fromEntries(columns.rows.map((row) => [row.column_name, row.is_nullable])),
    ).toEqual({
      document_type_id: "NO",
      owner_user_id: "YES",
      owning_org_unit_id: "NO",
      space_id: "YES",
    });
  });

  it("INV-DOC-002: persists exactly the three lifecycle and four variant enum values", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ enum_name: string; values: string[] }>(`
        select typ.typname as enum_name,
               array_agg(en.enumlabel::text order by en.enumsortorder)::text[] as values
          from pg_type typ
          join pg_enum en on en.enumtypid = typ.oid
          join pg_namespace n on n.oid = typ.typnamespace
         where n.nspname = 'public'
           and typ.typname = any(array['document_lifecycle', 'variant_type'])
         group by typ.typname
         order by typ.typname
      `),
    );
    expect(rows).toEqual([
      { enum_name: "document_lifecycle", values: ["PLANNED", "ACTIVE", "RETIRED"] },
      {
        enum_name: "variant_type",
        values: ["BASELINE", "REPLACEMENT", "SUPPLEMENT", "TRANSLATION"],
      },
    ]);
  });

  it("INV-APL-011 / INV-AUD-004: creates the document, one baseline and one event atomically", async () => {
    await withTenant(TENANT, async (sql) => {
      const created = await createDocument(transaction(sql), createInput());
      expect(created).toMatchObject({
        id: DOCUMENT,
        baselineVariantId: BASELINE,
        lifecycleStatus: "PLANNED",
        rowVersion: 1,
      });
      const variants = await sql.query<{
        id: string;
        variant_type: string;
        source_variant_id: null;
      }>(
        `select id, variant_type, source_variant_id
           from document_variant where document_id = $1`,
        [DOCUMENT],
      );
      expect(variants.rows).toEqual([
        { id: BASELINE, variant_type: "BASELINE", source_variant_id: null },
      ]);
      const events = await sql.query<{
        event_type: string;
        subject_type: string;
        document_id: string;
        document_variant_id: string;
        safe_before: unknown;
        safe_after: unknown;
      }>(
        `select event_type, subject_type, document_id, document_variant_id,
                safe_before, safe_after
           from audit_event where subject_id = $1`,
        [DOCUMENT],
      );
      expect(events.rows).toEqual([
        expect.objectContaining({
          event_type: "document.created",
          subject_type: "DOCUMENT",
          document_id: DOCUMENT,
          document_variant_id: BASELINE,
          safe_before: null,
          safe_after: expect.objectContaining({
            documentCode: "NEW-POL-001",
            ownerUserId: null,
            baselineVariantId: BASELINE,
          }),
        }),
      ]);
    });
  });

  it("INV-APL-011 / INV-AUD-004: rolls back both identities when their audit event fails", async () => {
    const documentId = "91000000-0000-0000-0013-000000000001";
    const baselineVariantId = "91000000-0000-0000-0014-000000000001";
    await expect(
      inCommittedTenant(TENANT, (sql) =>
        createDocument(
          transaction(sql),
          createInput({
            documentId,
            baselineVariantId,
            documentCode: "ATOMIC-FAILURE",
            configurationVersionId: OTHER_CONFIGURATION,
          }),
        ),
      ),
    ).rejects.toMatchObject({ constraint: "audit_event_configuration_version_fk" });

    await withTenant(TENANT, async (sql) => {
      const documents = await sql.query("select id from document where id = $1", [documentId]);
      const variants = await sql.query("select id from document_variant where id = $1", [
        baselineVariantId,
      ]);
      expect(documents.rows).toEqual([]);
      expect(variants.rows).toEqual([]);
    });
  });

  it("INV-AUD-004 / INV-AUD-008: emits each register mutation under its published v1 schema", async () => {
    await withTenant(TENANT, async (sql) => {
      await createDocument(transaction(sql), createInput());
      await changeDocumentMetadata(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 1,
        canonicalTitle: "Renamed Policy",
      });
      await changeDocumentOwner(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 2,
        ownerUserId: SECOND_USER,
      });
      await changeDocumentType(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 3,
        documentTypeId: SECOND_DOCUMENT_TYPE,
      });
      await retireDocument(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 4,
        retirementReason: "Initiative cancelled before effectivity",
      });

      const { rows } = await sql.query<{
        event_type: string;
        event_schema_version: number;
        safe_before: Record<string, unknown> | null;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, event_schema_version, safe_before, safe_after
           from audit_event where subject_id = $1 order by sequence`,
        [DOCUMENT],
      );
      expect(rows.map((row) => row.event_type)).toEqual([
        "document.created",
        "document.metadata_changed",
        "document.owner_changed",
        "document.type_changed",
        "document.retired",
      ]);
      expect(rows.every((row) => row.event_schema_version === 1)).toBe(true);
      expect(rows[1]).toMatchObject({
        safe_before: { canonicalTitle: "New Policy" },
        safe_after: { canonicalTitle: "Renamed Policy" },
      });
      expect(rows[2]).toMatchObject({
        safe_before: { ownerUserId: null },
        safe_after: { ownerUserId: SECOND_USER },
      });
      expect(rows[3]).toMatchObject({
        safe_before: { documentTypeId: DOCUMENT_TYPE },
        safe_after: { documentTypeId: SECOND_DOCUMENT_TYPE },
      });
      expect(rows[4]).toMatchObject({
        safe_before: { lifecycleStatus: "PLANNED" },
        safe_after: {
          lifecycleStatus: "RETIRED",
          retiredAt: FIXED_INSTANT.toISOString(),
          retirementReason: "Initiative cancelled before effectivity",
        },
      });
    });
  });

  it("INV-DOC-006: represents an unowned document and surfaces the ownership exception", async () => {
    await withTenant(TENANT, async (sql) => {
      await createDocument(transaction(sql), createInput({ ownerUserId: null }));
      const register = await listDocumentRegister(transaction(sql), TENANT);
      expect(register.find((row) => row.id === DOCUMENT)).toMatchObject({
        ownerUserId: null,
        ownershipException: true,
      });
    });
  });

  it("INV-APL-011: refuses a second baseline for one document", async () => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query(
          `insert into document_variant
             (tenant_id, id, document_id, variant_type, source_variant_id, status)
           values ($1, '91000000-0000-0000-0020-000000000001', $2,
                   'BASELINE', null, 'ACTIVE')`,
          [TENANT, EXISTING_DOCUMENT],
        ),
      ).rejects.toMatchObject({ constraint: "one_baseline_per_document" });
    });
  });

  it.each([
    {
      name: "a baseline with a source",
      id: "91000000-0000-0000-0021-000000000001",
      variantType: "BASELINE",
      source: EXISTING_BASELINE,
      locale: null,
      constraint: "document_variant_baseline_source",
    },
    {
      name: "a non-baseline without a source",
      id: "91000000-0000-0000-0021-000000000002",
      variantType: "SUPPLEMENT",
      source: null,
      locale: null,
      constraint: "document_variant_baseline_source",
    },
    {
      name: "a translation without a locale",
      id: "91000000-0000-0000-0021-000000000003",
      variantType: "TRANSLATION",
      source: EXISTING_BASELINE,
      locale: null,
      constraint: "document_variant_translation_locale",
    },
  ])("INV-APL-011: refuses $name", async ({ id, variantType, source, locale, constraint }) => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query(
          `insert into document_variant
             (tenant_id, id, document_id, variant_type, source_variant_id, locale, status)
           values ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
          [TENANT, id, EXISTING_DOCUMENT, variantType, source, locale],
        ),
      ).rejects.toMatchObject({ constraint });
    });
  });

  it("INV-DOC-004 / INV-APL-011: denies application deletion and declares every document child RESTRICT", async () => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query("delete from document_variant where id = $1", [EXISTING_BASELINE]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    const privileges = await withAppRole((sql) =>
      sql.query<{ table_name: string; can_delete: boolean; can_truncate: boolean }>(`
        select table_name,
               has_table_privilege('app_role', table_name, 'DELETE') as can_delete,
               has_table_privilege('app_role', table_name, 'TRUNCATE') as can_truncate
          from unnest(array['document', 'document_variant']) as table_name
         order by table_name
      `),
    );
    expect(privileges.rows).toEqual([
      { table_name: "document", can_delete: false, can_truncate: false },
      { table_name: "document_variant", can_delete: false, can_truncate: false },
    ]);
    const references = await withAppRole((sql) =>
      sql.query<{ constraint_name: string; delete_action: string }>(`
        select con.conname as constraint_name, con.confdeltype::text as delete_action
          from pg_constraint con
         where con.contype = 'f'
           and con.confrelid = 'document'::regclass
         order by con.conname
      `),
    );
    expect(references.rows.length).toBeGreaterThan(0);
    expect(references.rows.every((row) => row.delete_action === "r")).toBe(true);
  });

  it.each([
    {
      name: "a retirement without retired_at",
      retiredAt: null,
      reason: "Cancelled",
      constraint: "document_retirement_instant_consistent",
    },
    {
      name: "a retirement without a reason",
      retiredAt: FIXED_INSTANT.toISOString(),
      reason: null,
      constraint: "document_retirement_reason_required",
    },
  ])("INV-DOC-002: refuses $name", async ({ retiredAt, reason, constraint }) => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query(
          `update document
              set lifecycle_status = 'RETIRED', retired_at = $2, retirement_reason = $3,
                  row_version = row_version + 1
            where id = $1`,
          [EXISTING_DOCUMENT, retiredAt, reason],
        ),
      ).rejects.toMatchObject({ constraint });
    });
  });

  it("INV-DOC-007: refuses an application attempt to set ACTIVE directly", async () => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query(
          `update document set lifecycle_status = 'ACTIVE', row_version = row_version + 1
            where id = $1`,
          [EXISTING_DOCUMENT],
        ),
      ).rejects.toMatchObject({ constraint: "document_lifecycle_transition" });
    });
  });

  it("INV-DOC-002: enforces document_code uniqueness within, but not across, tenants", async () => {
    await withTenant(TENANT, async (sql) => {
      const own = await sql.query<{ count: number }>(
        "select count(*)::int as count from document where document_code = 'SHARED-CODE'",
      );
      expect(own.rows).toEqual([{ count: 1 }]);
      await expect(
        sql.query(
          `insert into document (
             tenant_id, id, document_code, canonical_title, document_type_id,
             owning_org_unit_id, lifecycle_status, is_governing_framework
           ) values ($1, '91000000-0000-0000-0022-000000000001', 'SHARED-CODE',
                     'Duplicate', $2, $3, 'PLANNED', false)`,
          [TENANT, DOCUMENT_TYPE, ORG_UNIT],
        ),
      ).rejects.toMatchObject({ constraint: "document_tenant_code_unique" });
    });
    await withTenant(OTHER_TENANT, async (sql) => {
      const own = await sql.query<{ count: number }>(
        "select count(*)::int as count from document where document_code = 'SHARED-CODE'",
      );
      expect(own.rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-TEN-003: hides cross-tenant documents and variants and makes their references unrepresentable", async () => {
    await withTenant(TENANT, async (sql) => {
      const documents = await sql.query("select id from document where id = $1", [OTHER_DOCUMENT]);
      const variants = await sql.query("select id from document_variant where id = $1", [
        OTHER_BASELINE,
      ]);
      expect(documents.rows).toEqual([]);
      expect(variants.rows).toEqual([]);
      await expect(
        changeDocumentOwner(transaction(sql), {
          ...createInput(),
          documentId: OTHER_DOCUMENT,
          expectedRowVersion: 1,
          ownerUserId: null,
        }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
      await expect(
        sql.query(
          `insert into document_variant
             (tenant_id, id, document_id, variant_type, source_variant_id, status)
           values ($1, '91000000-0000-0000-0023-000000000001', $2,
                   'SUPPLEMENT', $3, 'ACTIVE')`,
          [TENANT, OTHER_DOCUMENT, EXISTING_BASELINE],
        ),
      ).rejects.toMatchObject({ constraint: "document_variant_document_fk" });
    });
  });

  it("INV-TIME-003: rejects a stale metadata writer without emitting a second change", async () => {
    await withTenant(TENANT, async (sql) => {
      await createDocument(transaction(sql), createInput());
      await changeDocumentMetadata(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 1,
        canonicalTitle: "First writer",
      });
      await expect(
        changeDocumentOwner(transaction(sql), {
          ...createInput(),
          expectedRowVersion: 1,
          ownerUserId: SECOND_USER,
        }),
      ).rejects.toBeInstanceOf(DocumentConcurrencyError);
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where subject_id = $1 order by sequence",
        [DOCUMENT],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "document.created",
        "document.metadata_changed",
      ]);
    });
  });

  it("INV-DOC-004 / INV-APL-011 / INV-TEN-003: comments every invariant-bearing constraint", async () => {
    const expectedConstraints = [
      "audit_event_document_fk",
      "audit_event_document_variant_fk",
      "document_id_unique",
      "document_owner_fk",
      "document_owning_org_unit_fk",
      "document_pkey",
      "document_retirement_instant_consistent",
      "document_retirement_reason_required",
      "document_space_fk",
      "document_tenant_code_unique",
      "document_tenant_fk",
      "document_type_fk",
      "document_variant_baseline_source",
      "document_variant_document_fk",
      "document_variant_id_unique",
      "document_variant_pkey",
      "document_variant_source_fk",
      "document_variant_tenant_fk",
      "document_variant_translation_locale",
    ].sort();
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string; description: string | null }>(
        `
        select con.conrelid::regclass::text as table_name,
               con.conname as constraint_name,
               obj_description(con.oid, 'pg_constraint')::text as description
          from pg_constraint con
         where con.conname = any($1::text[])
           and con.connamespace = 'public'::regnamespace
         order by con.conrelid::regclass::text, con.conname
      `,
        [expectedConstraints],
      ),
    );
    expect(rows.map((row) => row.constraint_name).sort()).toEqual(expectedConstraints);
    for (const row of rows) {
      expect(row.description).toMatch(/INV-/);
    }
  });
});
