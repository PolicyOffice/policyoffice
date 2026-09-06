import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DIRECT_VERSION_LIFECYCLE_TRANSITIONS,
  DOCUMENT_VERSION_COLUMN_CLASSIFICATION,
  DocumentVersionNotFoundError,
  VERSION_LIFECYCLE_STATES,
  changeVersionMateriality,
  changeVersionMetadata,
  createDocumentVersion,
  type AuditTransaction,
  type CreateDocumentVersionInput,
  type Materiality,
  type VersionLifecycle,
} from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "93000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "94000000-0000-0000-0000-000000000002";
const USER = "93000000-0000-0000-0001-000000000001";
const OTHER_USER = "94000000-0000-0000-0001-000000000001";
const LEGAL_ENTITY = "93000000-0000-0000-0002-000000000001";
const OTHER_LEGAL_ENTITY = "94000000-0000-0000-0002-000000000001";
const ORG_UNIT = "93000000-0000-0000-0003-000000000001";
const OTHER_ORG_UNIT = "94000000-0000-0000-0003-000000000001";
const CONFIGURATION = "93000000-0000-0000-0004-000000000001";
const SECOND_CONFIGURATION = "93000000-0000-0000-0004-000000000002";
const OTHER_CONFIGURATION = "94000000-0000-0000-0004-000000000001";
const DOCUMENT_TYPE = "93000000-0000-0000-0005-000000000001";
const SECOND_DOCUMENT_TYPE = "93000000-0000-0000-0005-000000000002";
const OTHER_DOCUMENT_TYPE = "94000000-0000-0000-0005-000000000001";
const CLASSIFICATION = "93000000-0000-0000-0006-000000000001";
const SECOND_CLASSIFICATION = "93000000-0000-0000-0006-000000000002";
const OTHER_CLASSIFICATION = "94000000-0000-0000-0006-000000000001";
const DOCUMENT = "93000000-0000-0000-0007-000000000001";
const OTHER_DOCUMENT = "94000000-0000-0000-0007-000000000001";
const BASELINE = "93000000-0000-0000-0008-000000000001";
const SECOND_VARIANT = "93000000-0000-0000-0008-000000000002";
const RACE_VARIANT = "93000000-0000-0000-0008-000000000003";
const OTHER_BASELINE = "94000000-0000-0000-0008-000000000001";
const VERSION = "93000000-0000-0000-0009-000000000001";
const REQUEST = "93000000-0000-0000-0010-000000000001";
const CORRELATION = "93000000-0000-0000-0011-000000000001";
const FIXED_INSTANT = new Date("2027-02-01T10:00:00.000Z");

interface Seed {
  tenantId: string;
  userId: string;
  legalEntityId: string;
  orgUnitId: string;
  configurationId: string;
  documentTypeId: string;
  classificationId: string;
  documentId: string;
  baselineId: string;
  label: string;
}

interface InsertVersion {
  id: string;
  variantId?: string;
  sequence?: number;
  lifecycle?: VersionLifecycle;
  documentTypeId?: string;
  classificationId?: string;
  materiality?: Materiality | null;
  displayLabel?: string | null;
  changeSummary?: string | null;
  approvedRevisionId?: string | null;
  contentDigest?: string | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  withdrawnAt?: string | null;
  withdrawalReason?: string | null;
  configurationId?: string | null;
}

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function createInput(
  overrides: Partial<CreateDocumentVersionInput> = {},
): CreateDocumentVersionInput {
  return {
    tenantId: TENANT,
    versionId: VERSION,
    documentVariantId: BASELINE,
    displayLabel: "1.0",
    classificationId: CLASSIFICATION,
    materiality: "NON_MATERIAL",
    changeSummary: "Initial controlled version",
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

async function withMigrationTenant<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      return await fn(sql);
    } finally {
      await sql.query("rollback");
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
      await sql.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
    }
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function seedTenant(seed: Seed): Promise<void> {
  await inCommittedTenant(seed.tenantId, async (sql) => {
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [
        seed.tenantId,
        seed.userId,
        `${seed.label} version owner`,
        `${seed.label.toLowerCase()}-version@example.test`,
      ],
    );
    await sql.query(
      `insert into legal_entity
         (tenant_id, id, legal_name, country_of_registration, status)
       values ($1, $2, $3, 'EE', 'ACTIVE')`,
      [seed.tenantId, seed.legalEntityId, `${seed.label} OÜ`],
    );
    await sql.query(
      `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
       values ($1, $2, 'Compliance', $3, $4, 'ACTIVE')`,
      [seed.tenantId, seed.orgUnitId, `VERSION_${seed.label}`, seed.legalEntityId],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, $3, $4, 'Initial version test configuration', false, $5)`,
      [
        seed.tenantId,
        seed.configurationId,
        FIXED_INSTANT.toISOString(),
        seed.userId,
        `sha256:${seed.label.toLowerCase()}-version-configuration`,
      ],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority,
         default_review_rule, requires_attestation_by_default, status
       ) values ($1, $2, $3, 'Policy', 10, '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
      [seed.tenantId, seed.documentTypeId, `POLICY_${seed.label}`],
    );
    await sql.query(
      `insert into information_classification (
         tenant_id, id, code, name, rank, handling_instructions,
         externally_disclosable, status
       ) values ($1, $2, $3, 'Internal', 10, 'Internal use', false, 'ACTIVE')`,
      [seed.tenantId, seed.classificationId, `INTERNAL_${seed.label}`],
    );
    await sql.query(
      `insert into document (
         tenant_id, id, document_code, canonical_title, document_type_id,
         owning_org_unit_id, lifecycle_status, is_governing_framework
       ) values ($1, $2, $3, $4, $5, $6, 'PLANNED', false)`,
      [
        seed.tenantId,
        seed.documentId,
        `VERSION-${seed.label}`,
        `${seed.label} Information Security Policy`,
        seed.documentTypeId,
        seed.orgUnitId,
      ],
    );
    await sql.query(
      `insert into document_variant
         (tenant_id, id, document_id, variant_type, status)
       values ($1, $2, $3, 'BASELINE', 'ACTIVE')`,
      [seed.tenantId, seed.baselineId, seed.documentId],
    );
  });
}

function lifecyclePath(from: VersionLifecycle, to: VersionLifecycle): VersionLifecycle[] {
  if (from === to) return [];
  const queue: Array<{ state: VersionLifecycle; path: VersionLifecycle[] }> = [
    { state: from, path: [] },
  ];
  const visited = new Set<VersionLifecycle>([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const transition of DIRECT_VERSION_LIFECYCLE_TRANSITIONS) {
      if (transition.from !== current.state) continue;
      const next = transition.to as VersionLifecycle;
      const path = [...current.path, next];
      if (next === to) return path;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ state: next, path });
      }
    }
  }
  throw new Error(`no permitted test fixture path from ${from} to ${to}`);
}

async function transitionVersion(
  sql: Sql,
  id: string,
  to: VersionLifecycle,
  options: {
    withdrawnAt?: string | null | undefined;
    withdrawalReason?: string | null | undefined;
  } = {},
): Promise<number> {
  const { rows } = await sql.query<{ row_version: number }>(
    `update document_version
        set lifecycle_state = $2::version_lifecycle,
            withdrawn_at = case
              when $2::version_lifecycle = 'WITHDRAWN'
                then coalesce($3::timestamptz, withdrawn_at, statement_timestamp())
              else withdrawn_at
            end,
            withdrawal_reason = case
              when $2::version_lifecycle = 'WITHDRAWN'
                then coalesce(nullif(btrim($4::text), ''), withdrawal_reason,
                              'Withdrawn in lifecycle test')
              else withdrawal_reason
            end,
            row_version = row_version + 1
      where id = $1
      returning row_version`,
    [id, to, options.withdrawnAt ?? null, options.withdrawalReason ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error(`test fixture version ${id} was not found`);
  return row.row_version;
}

async function walkVersionLifecycle(
  sql: Sql,
  id: string,
  from: VersionLifecycle,
  to: VersionLifecycle,
  options: {
    withdrawnAt?: string | null | undefined;
    withdrawalReason?: string | null | undefined;
  } = {},
): Promise<number> {
  let rowVersion = 1;
  for (const next of lifecyclePath(from, to)) {
    rowVersion = await transitionVersion(sql, id, next, options);
  }
  return rowVersion;
}

async function insertVersion(sql: Sql, input: InsertVersion): Promise<number> {
  const lifecycle = input.lifecycle ?? "PUBLISHED";
  await sql.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id,
       approved_revision_id, content_digest, materiality, change_summary,
       effective_from, effective_until, withdrawn_at, withdrawal_reason,
       configuration_version_id
     ) values (
       $1, $2, $3, $4, $5, $6::version_lifecycle, $7,
       'Version test policy', $8, $9, $10, $11::materiality, $12,
       $13, $14, null, null, $15
     )`,
    [
      TENANT,
      input.id,
      input.variantId ?? BASELINE,
      input.sequence ?? 1,
      input.displayLabel ?? "1.0",
      "DRAFT",
      input.documentTypeId ?? DOCUMENT_TYPE,
      input.classificationId ?? CLASSIFICATION,
      input.approvedRevisionId ?? null,
      input.contentDigest ?? "sha256:version",
      input.materiality === undefined ? "MATERIAL" : input.materiality,
      input.changeSummary ?? "Version test change",
      input.effectiveFrom ?? null,
      input.effectiveUntil ?? null,
      input.configurationId === undefined ? CONFIGURATION : input.configurationId,
    ],
  );
  return walkVersionLifecycle(sql, input.id, "DRAFT", lifecycle, {
    withdrawnAt: input.withdrawnAt,
    withdrawalReason: input.withdrawalReason,
  });
}

const PERMITTED_VERSION_LIFECYCLE_PAIRS = DIRECT_VERSION_LIFECYCLE_TRANSITIONS.map(
  ({ from, to }) => [from, to] as const,
);
const permittedVersionLifecycleKeys = new Set(
  PERMITTED_VERSION_LIFECYCLE_PAIRS.map(([from, to]) => `${from}->${to}`),
);
const FORBIDDEN_VERSION_LIFECYCLE_PAIRS = VERSION_LIFECYCLE_STATES.flatMap((from) =>
  VERSION_LIFECYCLE_STATES.map((to) => [from, to] as const),
).filter(([from, to]) => !permittedVersionLifecycleKeys.has(`${from}->${to}`));

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT);
    await clearTenant(sql, OTHER_TENANT);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Version tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other version tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
  });
  await seedTenant({
    tenantId: TENANT,
    userId: USER,
    legalEntityId: LEGAL_ENTITY,
    orgUnitId: ORG_UNIT,
    configurationId: CONFIGURATION,
    documentTypeId: DOCUMENT_TYPE,
    classificationId: CLASSIFICATION,
    documentId: DOCUMENT,
    baselineId: BASELINE,
    label: "A",
  });
  await seedTenant({
    tenantId: OTHER_TENANT,
    userId: OTHER_USER,
    legalEntityId: OTHER_LEGAL_ENTITY,
    orgUnitId: OTHER_ORG_UNIT,
    configurationId: OTHER_CONFIGURATION,
    documentTypeId: OTHER_DOCUMENT_TYPE,
    classificationId: OTHER_CLASSIFICATION,
    documentId: OTHER_DOCUMENT,
    baselineId: OTHER_BASELINE,
    label: "B",
  });
  await inCommittedTenant(TENANT, async (sql) => {
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 2, $3, $4, 'Second test configuration', false, 'sha256:second')`,
      [TENANT, SECOND_CONFIGURATION, FIXED_INSTANT.toISOString(), USER],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority,
         default_review_rule, requires_attestation_by_default, status
       ) values ($1, $2, 'PROCEDURE_A', 'Procedure', 20, '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
      [TENANT, SECOND_DOCUMENT_TYPE],
    );
    await sql.query(
      `insert into information_classification (
         tenant_id, id, code, name, rank, handling_instructions,
         externally_disclosable, status
       ) values ($1, $2, 'CONFIDENTIAL_A', 'Confidential', 20, 'Restricted', false, 'ACTIVE')`,
      [TENANT, SECOND_CLASSIFICATION],
    );
    await sql.query(
      `insert into document_variant
         (tenant_id, id, document_id, variant_type, source_variant_id, status)
       values
         ($1, $2, $4, 'SUPPLEMENT', $5, 'ACTIVE'),
         ($1, $3, $4, 'REPLACEMENT', $5, 'ACTIVE')`,
      [TENANT, SECOND_VARIANT, RACE_VARIANT, DOCUMENT, BASELINE],
    );
  });
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT);
    await clearTenant(sql, OTHER_TENANT);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
  });
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("document version effectivity and immutability", () => {
  it("INV-EFF-001 / INV-EFF-006 / INV-DOC-009 / INV-DOC-010 / INV-TEN-003: installs the exact tenant-owned version shape", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(`
        select array_agg(a.attname::text order by a.attname) filter (where a.attnum > 0) as columns,
               c.relrowsecurity as row_security,
               c.relforcerowsecurity as force_row_security,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
         where n.nspname = 'public' and c.relname = 'document_version'
         group by c.oid, c.relrowsecurity, c.relforcerowsecurity
      `),
    );
    const classifiedColumns = Object.values(DOCUMENT_VERSION_COLUMN_CLASSIFICATION).flat().sort();
    expect(rows).toEqual([
      {
        columns: classifiedColumns,
        row_security: true,
        force_row_security: true,
        policy_count: 1,
      },
    ]);

    const enums = await withAppRole((sql) =>
      sql.query<{ enum_name: string; values: string[] }>(`
        select typ.typname as enum_name,
               array_agg(en.enumlabel::text order by en.enumsortorder)::text[] as values
          from pg_type typ
          join pg_enum en on en.enumtypid = typ.oid
          join pg_namespace n on n.oid = typ.typnamespace
         where n.nspname = 'public'
           and typ.typname = any(array['materiality', 'version_lifecycle'])
         group by typ.typname order by typ.typname
      `),
    );
    expect(enums.rows).toEqual([
      {
        enum_name: "materiality",
        values: ["EDITORIAL", "NON_MATERIAL", "MATERIAL", "EMERGENCY"],
      },
      {
        enum_name: "version_lifecycle",
        values: [
          "DRAFT",
          "IN_REVIEW",
          "CHANGES_REQUESTED",
          "APPROVED",
          "PUBLISHED",
          "EFFECTIVE",
          "SUPERSEDED",
          "WITHDRAWN",
          "REJECTED",
          "CANCELLED",
        ],
      },
    ]);
  });

  it.each(VERSION_LIFECYCLE_STATES.filter((state) => state !== "DRAFT"))(
    "refuses creating a document version directly as %s",
    async (state) => {
      await withTenant(TENANT, async (sql) => {
        await expect(
          sql.query(
            `insert into document_version (
               tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
               document_type_id, title, classification_id, configuration_version_id
             ) values ($1, $2, $3, 1, $4::version_lifecycle, $5,
                       'Invalid initial lifecycle', $6, $7)`,
            [TENANT, VERSION, BASELINE, state, DOCUMENT_TYPE, CLASSIFICATION, CONFIGURATION],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "document_version_lifecycle_transition",
        });
      });
    },
  );

  it.each(PERMITTED_VERSION_LIFECYCLE_PAIRS)(
    "permits the specified document version transition %s → %s",
    async (from, to) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql, { id: VERSION, lifecycle: from });
        await transitionVersion(sql, VERSION, to);
        const { rows } = await sql.query<{ lifecycle_state: VersionLifecycle }>(
          "select lifecycle_state from document_version where id = $1",
          [VERSION],
        );
        expect(rows).toEqual([{ lifecycle_state: to }]);
      });
    },
  );

  it.each(FORBIDDEN_VERSION_LIFECYCLE_PAIRS)(
    "refuses unspecified document version transition %s → %s",
    async (from, to) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql, { id: VERSION, lifecycle: from });
        await expect(transitionVersion(sql, VERSION, to)).rejects.toMatchObject({
          code: "23514",
        });
      });
    },
  );

  it("INV-EFF-001: refuses APPROVED → EFFECTIVE because publication is a distinct step", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "APPROVED" });
      await expect(transitionVersion(sql, VERSION, "EFFECTIVE")).rejects.toMatchObject({
        code: "23514",
        constraint: "document_version_lifecycle_transition",
      });
    });
  });

  it("INV-VER-003: refuses EFFECTIVE → DRAFT so released content cannot be thawed", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "EFFECTIVE" });
      await expect(transitionVersion(sql, VERSION, "DRAFT")).rejects.toMatchObject({
        code: "23514",
      });
    });
  });

  it.each(["SUPERSEDED", "WITHDRAWN"] as const)(
    "INV-EFF-004: refuses %s → EFFECTIVE so historical versions cannot be resurrected",
    async (from) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql, { id: VERSION, lifecycle: from });
        await expect(transitionVersion(sql, VERSION, "EFFECTIVE")).rejects.toMatchObject({
          code: "23514",
          constraint: "document_version_lifecycle_transition",
        });
      });
    },
  );

  it("refuses IN_REVIEW → DRAFT without a recorded changes-requested decision", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "IN_REVIEW" });
      await expect(transitionVersion(sql, VERSION, "DRAFT")).rejects.toMatchObject({
        code: "23514",
        constraint: "document_version_lifecycle_transition",
      });
    });
  });

  it.each(VERSION_LIFECYCLE_STATES)(
    "allows an update that does not touch lifecycle_state while the version is %s",
    async (state) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql, { id: VERSION, lifecycle: state });
        const { rows } = await sql.query<{ display_label: string; lifecycle_state: string }>(
          `update document_version
              set display_label = $2, row_version = row_version + 1
            where id = $1
            returning display_label, lifecycle_state`,
          [VERSION, `updated-${state.toLowerCase()}`],
        );
        expect(rows).toEqual([
          {
            display_label: `updated-${state.toLowerCase()}`,
            lifecycle_state: state,
          },
        ]);
      });
    },
  );

  it("INV-VER-003 / INV-EFF-001 / INV-EFF-004 / INV-TEN-001: documents an invoker-rights lifecycle trigger", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        function_comment: string | null;
        trigger_comment: string | null;
        trigger_definition: string;
        security_definer: boolean;
      }>(`
        select obj_description(p.oid, 'pg_proc')::text as function_comment,
               obj_description(t.oid, 'pg_trigger')::text as trigger_comment,
               pg_get_triggerdef(t.oid)::text as trigger_definition,
               p.prosecdef as security_definer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_trigger t on t.tgfoid = p.oid
         where n.nspname = 'public'
           and p.proname = 'assert_version_lifecycle_transition'
           and t.tgname = 'document_version_lifecycle_transition'
      `),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ security_definer: false });
    expect(rows[0]?.function_comment).toMatch(/INV-VER-003/);
    expect(rows[0]?.function_comment).toMatch(/INV-EFF-001/);
    expect(rows[0]?.function_comment).toMatch(/INV-EFF-004/);
    expect(rows[0]?.trigger_comment).toMatch(/INV-VER-003/);
    expect(rows[0]?.trigger_comment).toMatch(/INV-EFF-001/);
    expect(rows[0]?.trigger_comment).toMatch(/INV-EFF-004/);
    expect(rows[0]?.trigger_definition).toMatch(/BEFORE INSERT OR UPDATE OF lifecycle_state/i);
  });

  it("INV-EFF-002: stores effective_range as a generated STORED column", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ attgenerated: string; expression: string }>(`
        select att.attgenerated::text as attgenerated,
               pg_get_expr(def.adbin, def.adrelid)::text as expression
          from pg_attribute att
          join pg_attrdef def on def.adrelid = att.attrelid and def.adnum = att.attnum
         where att.attrelid = 'document_version'::regclass
           and att.attname = 'effective_range'
      `),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attgenerated).toBe("s");
    expect(rows[0]?.expression).toMatch(/case/i);
    expect(rows[0]?.expression).toMatch(/tstzrange/i);
  });

  it("INV-EFF-002: null effective_from yields null ranges and does not enter the exclusion constraint", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "REJECTED", sequence: 1 });
      await insertVersion(sql, {
        id: "93000000-0000-0000-0009-000000000002",
        lifecycle: "CANCELLED",
        sequence: 2,
      });
      const { rows } = await sql.query<{ effective_range: string | null }>(
        "select effective_range::text from document_version order by version_sequence",
      );
      expect(rows).toEqual([{ effective_range: null }, { effective_range: null }]);
    });
  });

  it("INV-EFF-002: refuses overlapping intervals on one variant by constraint name", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, {
        id: VERSION,
        sequence: 1,
        effectiveFrom: "2027-10-01T00:00:00Z",
      });
      await expect(
        insertVersion(sql, {
          id: "93000000-0000-0000-0009-000000000002",
          sequence: 2,
          effectiveFrom: "2027-11-01T00:00:00Z",
        }),
      ).rejects.toMatchObject({
        code: "23P01",
        constraint: "one_effective_version_per_variant",
      });
    });
  });

  it("INV-EFF-002: permits the same interval on two variants of one document", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, {
        id: VERSION,
        variantId: BASELINE,
        effectiveFrom: "2027-10-01T00:00:00Z",
      });
      await insertVersion(sql, {
        id: "93000000-0000-0000-0009-000000000002",
        variantId: SECOND_VARIANT,
        effectiveFrom: "2027-10-01T00:00:00Z",
      });
      const result = await sql.query("select id from document_version");
      expect(result.rows).toHaveLength(2);
    });
  });

  it("INV-TIME-005: permits consecutive half-open intervals to abut", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, {
        id: VERSION,
        sequence: 1,
        effectiveFrom: "2027-10-01T00:00:00Z",
        effectiveUntil: "2027-11-01T00:00:00Z",
      });
      await insertVersion(sql, {
        id: "93000000-0000-0000-0009-000000000002",
        sequence: 2,
        effectiveFrom: "2027-11-01T00:00:00Z",
        effectiveUntil: "2027-12-01T00:00:00Z",
      });
      const result = await sql.query("select id from document_version");
      expect(result.rows).toHaveLength(2);
    });
  });

  it("INV-VER-012: permits only one pre-release version until the first becomes published", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "DRAFT", sequence: 1 });
      await sql.query("savepoint duplicate_candidate");
      await expect(
        insertVersion(sql, {
          id: "93000000-0000-0000-0009-000000000002",
          lifecycle: "DRAFT",
          sequence: 2,
        }),
      ).rejects.toMatchObject({ constraint: "one_pre_release_version_per_variant" });
      await sql.query("rollback to savepoint duplicate_candidate");
      await sql.query("release savepoint duplicate_candidate");
      await walkVersionLifecycle(sql, VERSION, "DRAFT", "PUBLISHED");
      await insertVersion(sql, {
        id: "93000000-0000-0000-0009-000000000002",
        lifecycle: "DRAFT",
        sequence: 2,
      });
      const result = await sql.query("select id from document_version");
      expect(result.rows).toHaveLength(2);
    });
  });

  const governedChanges: ReadonlyArray<readonly [column: string, value: string | number]> = [
    ["document_variant_id", SECOND_VARIANT],
    ["version_sequence", 2],
    ["document_type_id", SECOND_DOCUMENT_TYPE],
    ["title", "Changed governed title"],
    ["classification_id", SECOND_CLASSIFICATION],
    ["materiality", "EMERGENCY"],
    ["change_summary", "Changed governed summary"],
    ["effective_from", "2027-10-01T00:00:00Z"],
    ["effective_until", "2027-11-01T00:00:00Z"],
    ["content_digest", "sha256:changed"],
    ["approved_revision_id", "93000000-0000-0000-0012-000000000001"],
    ["configuration_version_id", SECOND_CONFIGURATION],
  ];

  it.each(governedChanges)(
    "INV-VER-003 / INV-VER-007: refuses changing approved governed column %s",
    async (column, value) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql, { id: VERSION, lifecycle: "APPROVED" });
        await expect(
          sql.query(
            `update document_version
                set ${column} = $2, row_version = row_version + 1
              where id = $1`,
            [VERSION, value],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "document_version_governed_columns_immutable",
        });
      });
    },
  );

  it("INV-VER-003 / INV-VER-007: refuses thawing an approved version before changing it", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "APPROVED" });
      await expect(
        sql.query(
          `update document_version
              set lifecycle_state = 'DRAFT', row_version = row_version + 1
            where id = $1`,
          [VERSION],
        ),
      ).rejects.toMatchObject({
        constraint: "document_version_governed_columns_immutable",
      });
    });
  });

  it("INV-VER-008: changes an approved display label and emits version.metadata_changed", async () => {
    await withTenant(TENANT, async (sql) => {
      const rowVersion = await insertVersion(sql, {
        id: VERSION,
        lifecycle: "APPROVED",
        displayLabel: "1.0",
      });
      const changed = await changeVersionMetadata(transaction(sql), {
        ...createInput(),
        expectedRowVersion: rowVersion,
        displayLabel: "2027.01",
      });
      expect(changed).toMatchObject({ id: VERSION, rowVersion: rowVersion + 1 });
      const { rows } = await sql.query<{
        event_type: string;
        subject_type: string;
        safe_before: Record<string, unknown>;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, subject_type, safe_before, safe_after
           from audit_event where document_version_id = $1`,
        [VERSION],
      );
      expect(rows).toEqual([
        {
          event_type: "version.metadata_changed",
          subject_type: "DOCUMENT_VERSION",
          safe_before: { displayLabel: "1.0" },
          safe_after: { displayLabel: "2027.01" },
        },
      ]);
    });
  });

  it("INV-VER-006 / INV-VER-011: allocates after a cancelled sequence without renumbering or reusing it", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "PUBLISHED", sequence: 1 });
      await insertVersion(sql, {
        id: "93000000-0000-0000-0009-000000000002",
        lifecycle: "CANCELLED",
        sequence: 2,
      });
      const created = await createDocumentVersion(
        transaction(sql),
        createInput({ versionId: "93000000-0000-0000-0009-000000000003" }),
      );
      expect(created).toMatchObject({
        versionSequence: 3,
        documentTypeId: DOCUMENT_TYPE,
        title: "A Information Security Policy",
        lifecycleState: "DRAFT",
      });
      const versions = await sql.query<{ version_sequence: number; lifecycle_state: string }>(
        "select version_sequence, lifecycle_state from document_version order by version_sequence",
      );
      expect(versions.rows).toEqual([
        { version_sequence: 1, lifecycle_state: "PUBLISHED" },
        { version_sequence: 2, lifecycle_state: "CANCELLED" },
        { version_sequence: 3, lifecycle_state: "DRAFT" },
      ]);
      const events = await sql.query<{ event_type: string; safe_after: Record<string, unknown> }>(
        "select event_type, safe_after from audit_event where document_version_id = $1",
        [created.id],
      );
      expect(events.rows).toEqual([
        {
          event_type: "version.created",
          safe_after: expect.objectContaining({
            documentVariantId: BASELINE,
            versionSequence: 3,
            documentTypeId: DOCUMENT_TYPE,
            classificationId: CLASSIFICATION,
            materiality: "NON_MATERIAL",
          }),
        },
      ]);
    });
  });

  it("INV-VER-007: changes draft materiality and emits its v1 event", async () => {
    await withTenant(TENANT, async (sql) => {
      await createDocumentVersion(transaction(sql), createInput());
      const changed = await changeVersionMateriality(transaction(sql), {
        ...createInput(),
        expectedRowVersion: 1,
        materiality: "MATERIAL",
      });
      expect(changed.rowVersion).toBe(2);
      const { rows } = await sql.query<{
        event_type: string;
        safe_before: Record<string, unknown> | null;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, safe_before, safe_after
           from audit_event where document_version_id = $1 order by sequence`,
        [VERSION],
      );
      expect(rows).toEqual([
        expect.objectContaining({ event_type: "version.created", safe_before: null }),
        {
          event_type: "version.materiality_changed",
          safe_before: { materiality: "NON_MATERIAL" },
          safe_after: { materiality: "MATERIAL" },
        },
      ]);
    });
  });

  it("INV-DOC-008 / INV-EFF-006: refuses retirement while an interval currently governs, even with stale lifecycle bookkeeping", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, {
        id: VERSION,
        lifecycle: "PUBLISHED",
        effectiveFrom: "2020-01-01T00:00:00Z",
      });
      await expect(
        sql.query(
          `update document
              set lifecycle_status = 'RETIRED', retired_at = now(),
                  retirement_reason = 'Attempted quiet retirement',
                  row_version = row_version + 1
            where id = $1`,
          [DOCUMENT],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "document_no_retire_while_effective",
      });
    });
  });

  it("INV-EFF-004: withdrawal closes rather than erases the historical interval", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, {
        id: VERSION,
        lifecycle: "WITHDRAWN",
        effectiveFrom: "2027-01-01T00:00:00Z",
        effectiveUntil: "2027-02-01T00:00:00Z",
        withdrawnAt: "2027-02-01T00:00:00Z",
      });
      const { rows } = await sql.query<{
        closed_at_withdrawal: boolean;
        governed_before: boolean;
        governed_after: boolean;
      }>(
        `select effective_until = withdrawn_at as closed_at_withdrawal,
                effective_range @> '2027-01-15T00:00:00Z'::timestamptz as governed_before,
                effective_range @> '2027-02-15T00:00:00Z'::timestamptz as governed_after
           from document_version where id = $1`,
        [VERSION],
      );
      expect(rows).toEqual([
        { closed_at_withdrawal: true, governed_before: true, governed_after: false },
      ]);
    });
  });

  it("INV-EFF-006: exposes no is_current column or view", async () => {
    const columns = await withAppRole((sql) =>
      sql.query<{ count: number }>(`
        select count(*)::int as count
          from information_schema.columns
         where table_schema = 'public' and column_name = 'is_current'
      `),
    );
    expect(columns.rows).toEqual([{ count: 0 }]);
    const views = await withAppRole((sql) =>
      sql.query<{ count: number }>(`
        select count(*)::int as count
          from pg_views
         where schemaname = 'public'
           and coalesce(definition, '') ~* '\\mis_current\\M'
      `),
    );
    expect(views.rows).toEqual([{ count: 0 }]);
  });

  it("INV-VER-005 / INV-DOC-004: refuses application deletion of a version", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION });
      await expect(
        sql.query("delete from document_version where id = $1", [VERSION]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    const privileges = await withAppRole((sql) =>
      sql.query<{ can_delete: boolean; can_truncate: boolean }>(`
        select has_table_privilege('app_role', 'document_version', 'DELETE') as can_delete,
               has_table_privilege('app_role', 'document_version', 'TRUNCATE') as can_truncate
      `),
    );
    expect(privileges.rows).toEqual([{ can_delete: false, can_truncate: false }]);
  });

  it("INV-TEN-003: resolves the deferred document-type foreign key to an exact tenant version", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION });
      await sql.query(
        `update document_type
            set mandated_by_document_version_id = $2, row_version = row_version + 1
          where id = $1`,
        [DOCUMENT_TYPE, VERSION],
      );
      const result = await sql.query<{ mandated_by_document_version_id: string }>(
        "select mandated_by_document_version_id from document_type where id = $1",
        [DOCUMENT_TYPE],
      );
      expect(result.rows).toEqual([{ mandated_by_document_version_id: VERSION }]);
    });
    const constraints = await withAppRole((sql) =>
      sql.query<{ constraint_name: string; delete_action: string }>(`
        select con.conname as constraint_name, con.confdeltype::text as delete_action
          from pg_constraint con
         where con.conname = 'document_type_mandated_by_version_fk'
      `),
    );
    expect(constraints.rows).toEqual([
      { constraint_name: "document_type_mandated_by_version_fk", delete_action: "r" },
    ]);
  });

  it("INV-TEN-001 / INV-TEN-002 / INV-TEN-003: hides cross-tenant versions and references", async () => {
    await withTenant(OTHER_TENANT, async (sql) => {
      await sql.query(
        `insert into document_version (
           tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
           document_type_id, title, classification_id, configuration_version_id
         ) values ($1, $2, $3, 1, 'DRAFT', $4, 'Other version', $5, $6)`,
        [
          OTHER_TENANT,
          "94000000-0000-0000-0009-000000000001",
          OTHER_BASELINE,
          OTHER_DOCUMENT_TYPE,
          OTHER_CLASSIFICATION,
          OTHER_CONFIGURATION,
        ],
      );
    });
    await withTenant(TENANT, async (sql) => {
      const hidden = await sql.query("select id from document_version where tenant_id = $1", [
        OTHER_TENANT,
      ]);
      expect(hidden.rows).toEqual([]);
      await expect(
        createDocumentVersion(transaction(sql), createInput({ documentVariantId: OTHER_BASELINE })),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundError);
      await expect(
        sql.query(
          `insert into document_version (
             tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
             document_type_id, title, classification_id, configuration_version_id
           ) values ($1, $2, $3, 1, 'DRAFT', $4, 'Cross tenant', $5, $6)`,
          [TENANT, VERSION, OTHER_BASELINE, DOCUMENT_TYPE, CLASSIFICATION, CONFIGURATION],
        ),
      ).rejects.toMatchObject({ constraint: "document_version_variant_fk" });
    });
  });

  it("INV-EFF-002: permits exactly one winner under a real concurrent overlap race", async () => {
    let signalInserted!: () => void;
    let releaseFirst!: () => void;
    let signalSecondStarted!: () => void;
    const firstInserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      signalSecondStarted = resolve;
    });

    const first = withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        await insertVersion(sql, {
          id: "93000000-0000-0000-0013-000000000001",
          variantId: RACE_VARIANT,
          sequence: 100,
          effectiveFrom: "2035-01-01T00:00:00Z",
          effectiveUntil: "2035-06-01T00:00:00Z",
        });
        signalInserted();
        await firstMayCommit;
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    });
    await firstInserted;

    const second = withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        signalSecondStarted();
        await insertVersion(sql, {
          id: "93000000-0000-0000-0013-000000000002",
          variantId: RACE_VARIANT,
          sequence: 101,
          effectiveFrom: "2035-03-01T00:00:00Z",
          effectiveUntil: "2035-09-01T00:00:00Z",
        });
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    });
    await secondStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirst();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: {
        code: "23P01",
        constraint: "one_effective_version_per_variant",
      },
    });
    await withTenant(TENANT, async (sql) => {
      const { rows } = await sql.query<{ count: number }>(
        `select count(*)::int as count from document_version
          where document_variant_id = $1 and version_sequence in (100, 101)`,
        [RACE_VARIANT],
      );
      expect(rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-VER-003 / INV-VER-007: reserves effectivity writes for migration-owned publication", async () => {
    const roles = await withAppRole((sql) =>
      sql.query<{ can_set_migration_role: boolean }>(`
        select pg_has_role('app_role', 'migration_role', 'SET') as can_set_migration_role
      `),
    );
    expect(roles.rows).toEqual([{ can_set_migration_role: false }]);
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql, { id: VERSION, lifecycle: "APPROVED" });
      await expect(
        sql.query(
          `update document_version
              set effective_from = '2028-01-01T00:00:00Z', row_version = row_version + 1
            where id = $1`,
          [VERSION],
        ),
      ).rejects.toMatchObject({
        constraint: "document_version_governed_columns_immutable",
      });
    });
  });

  it("INV-VER-007: lets migration-owned publication assign unset effectivity timestamps once", async () => {
    await withMigrationTenant(async (sql) => {
      const rowVersion = await insertVersion(sql, { id: VERSION, lifecycle: "APPROVED" });
      await sql.query(
        `update document_version
            set effective_from = '2028-01-01T00:00:00Z',
                row_version = row_version + 1
          where id = $1`,
        [VERSION],
      );
      await sql.query(
        `update document_version
            set effective_until = '2029-01-01T00:00:00Z',
                row_version = row_version + 1
          where id = $1`,
        [VERSION],
      );
      const { rows } = await sql.query<{
        effective_from: Date;
        effective_until: Date;
        row_version: number;
      }>(
        `select effective_from, effective_until, row_version
           from document_version where id = $1`,
        [VERSION],
      );
      expect(rows).toEqual([
        {
          effective_from: new Date("2028-01-01T00:00:00Z"),
          effective_until: new Date("2029-01-01T00:00:00Z"),
          row_version: rowVersion + 2,
        },
      ]);
    });
  });

  it.each([
    ["move", "effective_from", "2020-01-01T00:00:00Z"],
    ["clear", "effective_from", null],
    ["move", "effective_until", "2030-01-01T00:00:00Z"],
    ["clear", "effective_until", null],
  ] as const)(
    "INV-VER-007: refuses migration-owned %s of assigned %s",
    async (_change, column, replacement) => {
      await withMigrationTenant(async (sql) => {
        await insertVersion(sql, {
          id: VERSION,
          lifecycle: "APPROVED",
          effectiveFrom: "2028-01-01T00:00:00Z",
          effectiveUntil: "2029-01-01T00:00:00Z",
        });
        await expect(
          sql.query(
            `update document_version
                set ${column} = $2, row_version = row_version + 1
              where id = $1`,
            [VERSION, replacement],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "document_version_governed_columns_immutable",
        });
      });
    },
  );

  it("INV-VER-011 / INV-VER-012 / INV-EFF-002: comments every invariant-bearing version constraint without inventing coverage", async () => {
    const invariantConstraints = [
      "audit_event_document_version_fk",
      "document_type_mandated_by_version_fk",
      "document_version_classification_fk",
      "document_version_classification_id_not_null",
      "document_version_configuration_fk",
      "document_version_document_type_id_not_null",
      "document_version_id_unique",
      "document_version_pkey",
      "document_version_successor_fk",
      "document_version_tenant_fk",
      "document_version_title_not_null",
      "document_version_type_fk",
      "document_version_variant_fk",
      "document_version_variant_sequence_unique",
      "document_version_withdrawal_reason_required",
      "one_effective_version_per_variant",
    ].sort();
    const constraints = await withAppRole((sql) =>
      sql.query<{ constraint_name: string; description: string | null }>(
        `select con.conname as constraint_name,
                obj_description(con.oid, 'pg_constraint')::text as description
           from pg_constraint con
          where con.conname = any($1::text[])
            and con.connamespace = 'public'::regnamespace
          order by con.conname`,
        [invariantConstraints],
      ),
    );
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual(invariantConstraints);
    expect(constraints.rows.every((row) => /INV-/.test(row.description ?? ""))).toBe(true);

    const neutral = await withAppRole((sql) =>
      sql.query<{ description: string | null }>(`
        select obj_description(con.oid, 'pg_constraint')::text as description
          from pg_constraint con
         where con.conname = 'document_version_effective_interval_start_required'
      `),
    );
    expect(neutral.rows).toEqual([
      { description: "An interval cannot close unless it first has a lower bound" },
    ]);

    const indexes = await withAppRole((sql) =>
      sql.query<{ description: string | null }>(`
        select obj_description('one_pre_release_version_per_variant'::regclass, 'pg_class')::text
          as description
      `),
    );
    expect(indexes.rows[0]?.description).toMatch(/INV-VER-012/);
  });
});
