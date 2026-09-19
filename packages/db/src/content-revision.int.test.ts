import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANONICALISATION_SCHEMA_VERSION,
  ContentRevisionLifecycleError,
  ContentRevisionNotFoundError,
  WorkflowMandateUnsatisfiedError,
  WorkflowTemplateValidationError,
  addContentAttachment,
  buildCanonicalManifest,
  createContentRevision,
  digestCanonicalManifest,
  removeContentAttachment,
  replaceContentAttachment,
  serializeCanonicalManifest,
  sha256Digest,
  submitContentRevision,
  type AuditTransaction,
  type CreatedContentRevision,
  type SubmittedContentRevision,
} from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "96000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "97000000-0000-0000-0000-000000000001";
const USER = "96000000-0000-0000-0001-000000000001";
const OTHER_USER = "97000000-0000-0000-0001-000000000001";
const LEGAL_ENTITY = "96000000-0000-0000-0002-000000000001";
const OTHER_LEGAL_ENTITY = "97000000-0000-0000-0002-000000000001";
const ORG_UNIT = "96000000-0000-0000-0003-000000000001";
const OTHER_ORG_UNIT = "97000000-0000-0000-0003-000000000001";
const CONFIGURATION = "96000000-0000-0000-0004-000000000001";
const OTHER_CONFIGURATION = "97000000-0000-0000-0004-000000000001";
const WORKFLOW_TEMPLATE = "96000000-0000-0000-0004-000000000002";
const OTHER_WORKFLOW_TEMPLATE = "97000000-0000-0000-0004-000000000002";
const WORKFLOW_VERSION = "96000000-0000-0000-0004-000000000003";
const OTHER_WORKFLOW_VERSION = "97000000-0000-0000-0004-000000000003";
const DOCUMENT_TYPE = "96000000-0000-0000-0005-000000000001";
const OTHER_DOCUMENT_TYPE = "97000000-0000-0000-0005-000000000001";
const CLASSIFICATION = "96000000-0000-0000-0006-000000000001";
const OTHER_CLASSIFICATION = "97000000-0000-0000-0006-000000000001";
const DOCUMENT = "96000000-0000-0000-0007-000000000001";
const OTHER_DOCUMENT = "97000000-0000-0000-0007-000000000001";
const VARIANT = "96000000-0000-0000-0008-000000000001";
const OTHER_VARIANT = "97000000-0000-0000-0008-000000000001";
const VERSION = "96000000-0000-0000-0009-000000000001";
const OTHER_VERSION = "97000000-0000-0000-0009-000000000001";
const REVISION = "96000000-0000-0000-0010-000000000001";
const SECOND_REVISION = "96000000-0000-0000-0010-000000000002";
const THIRD_REVISION = "96000000-0000-0000-0010-000000000003";
const OTHER_REVISION = "97000000-0000-0000-0010-000000000001";
const ATTACHMENT = "96000000-0000-0000-0011-000000000001";
const SECOND_ATTACHMENT = "96000000-0000-0000-0011-000000000002";
const REQUEST = "96000000-0000-0000-0012-000000000001";
const CORRELATION = "96000000-0000-0000-0013-000000000001";
const FIXED_INSTANT = new Date("2027-03-01T10:00:00.000Z");
const BODY_BYTES = new TextEncoder().encode("Controlled policy body\n");

interface Seed {
  tenantId: string;
  userId: string;
  legalEntityId: string;
  orgUnitId: string;
  configurationId: string;
  workflowTemplateId: string;
  workflowVersionId: string;
  documentTypeId: string;
  classificationId: string;
  documentId: string;
  variantId: string;
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
    await sql.query(
      `update workflow_template
          set active_version_id = null, row_version = row_version + 1
        where tenant_id = $1 and active_version_id is not null`,
      [tenantId],
    );
    for (const table of [
      "audit_event",
      "tenant_event_sequence",
      "approval_task",
      "approval_stage",
      "approval_run",
      "content_attachment",
      "content_revision",
      "document_version",
      "document_variant",
      "document",
      "org_unit",
      "legal_entity",
      "document_type",
      "information_classification",
      "configuration_version",
      "workflow_template_version",
      "workflow_template",
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
      [seed.tenantId, seed.userId, `${seed.label} author`, `${seed.label}@revision.example.test`],
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
      [seed.tenantId, seed.orgUnitId, `REVISION_${seed.label}`, seed.legalEntityId],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, $3, $4, 'Initial revision test configuration', false, $5)`,
      [
        seed.tenantId,
        seed.configurationId,
        FIXED_INSTANT.toISOString(),
        seed.userId,
        `sha256:${seed.label.toLowerCase()}-revision-configuration`,
      ],
    );
    await sql.query(
      `insert into workflow_template (
         tenant_id, id, name, purpose, active_version_id, status
       ) values ($1, $2, 'Revision approval', 'Approve revision test candidates', null, 'ACTIVE')`,
      [seed.tenantId, seed.workflowTemplateId],
    );
    const stages = [
      {
        order: 1,
        name: "Named authority",
        completionRule: "ALL",
        participants: [{ type: "USER", id: seed.userId }],
      },
      {
        order: 2,
        name: "Final authority",
        completionRule: "ALL",
        participants: [{ type: "USER", id: seed.userId }],
      },
    ];
    await sql.query(
      `insert into workflow_template_version (
         tenant_id, id, workflow_template_id, version_sequence, stages,
         separation_of_duties_rules, published_at, published_by
       ) values ($1, $2, $3, 1, $4::jsonb, '[]'::jsonb, $5, $6)`,
      [
        seed.tenantId,
        seed.workflowVersionId,
        seed.workflowTemplateId,
        JSON.stringify(stages),
        FIXED_INSTANT.toISOString(),
        seed.userId,
      ],
    );
    await sql.query(
      `update workflow_template
          set active_version_id = $2, row_version = row_version + 1
        where id = $1`,
      [seed.workflowTemplateId, seed.workflowVersionId],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority,
         default_workflow_template_id, default_review_rule,
         requires_attestation_by_default, status
       ) values ($1, $2, $3, 'Policy', 10, $4::jsonb, $5, '{}'::jsonb, false, 'ACTIVE')`,
      [
        seed.tenantId,
        seed.documentTypeId,
        `POLICY_${seed.label}`,
        JSON.stringify({
          MATERIAL: { requires: [{ type: "USER", id: seed.userId }] },
        }),
        seed.workflowTemplateId,
      ],
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
        `REV-${seed.label}`,
        `${seed.label} policy`,
        seed.documentTypeId,
        seed.orgUnitId,
      ],
    );
    await sql.query(
      `insert into document_variant
         (tenant_id, id, document_id, variant_type, status)
       values ($1, $2, $3, 'BASELINE', 'ACTIVE')`,
      [seed.tenantId, seed.variantId, seed.documentId],
    );
  });
}

async function insertVersion(
  sql: Sql,
  tenantId = TENANT,
  versionId = VERSION,
  variantId = VARIANT,
  documentTypeId = DOCUMENT_TYPE,
  classificationId = CLASSIFICATION,
  configurationId = CONFIGURATION,
): Promise<void> {
  await sql.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id,
       materiality, change_summary, configuration_version_id
     ) values ($1, $2, $3, 1, '1.0', 'DRAFT', $4, 'Revision test policy',
               $5, 'MATERIAL', 'Initial controlled draft', $6)`,
    [tenantId, versionId, variantId, documentTypeId, classificationId, configurationId],
  );
}

function createRevision(
  sql: Sql,
  revisionId = REVISION,
  contentBytes: Uint8Array = BODY_BYTES,
): Promise<CreatedContentRevision> {
  return createContentRevision(transaction(sql), {
    tenantId: TENANT,
    revisionId,
    documentVersionId: VERSION,
    createdByUserId: USER,
    contentBytes,
    actor: { type: "USER", id: USER },
    configurationVersionId: CONFIGURATION,
    occurredAt: FIXED_INSTANT,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API",
  });
}

function submitRevision(
  sql: Sql,
  revisionId: string,
  expectedRevisionRowVersion: number,
  expectedVersionRowVersion: number,
): Promise<SubmittedContentRevision> {
  return submitContentRevision(transaction(sql), {
    tenantId: TENANT,
    documentVersionId: VERSION,
    revisionId,
    expectedVersionRowVersion,
    expectedRevisionRowVersion,
    actor: { type: "USER", id: USER },
    configurationVersionId: CONFIGURATION,
    occurredAt: FIXED_INSTANT,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API",
  });
}

async function atSavepoint(
  sql: Sql,
  name: string,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  await sql.query(`savepoint ${name}`);
  try {
    return await operation();
  } finally {
    await sql.query(`rollback to savepoint ${name}`);
    await sql.query(`release savepoint ${name}`);
  }
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT);
    await clearTenant(sql, OTHER_TENANT);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Revision tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other revision tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
  });
  await seedTenant({
    tenantId: TENANT,
    userId: USER,
    legalEntityId: LEGAL_ENTITY,
    orgUnitId: ORG_UNIT,
    configurationId: CONFIGURATION,
    workflowTemplateId: WORKFLOW_TEMPLATE,
    workflowVersionId: WORKFLOW_VERSION,
    documentTypeId: DOCUMENT_TYPE,
    classificationId: CLASSIFICATION,
    documentId: DOCUMENT,
    variantId: VARIANT,
    label: "A",
  });
  await seedTenant({
    tenantId: OTHER_TENANT,
    userId: OTHER_USER,
    legalEntityId: OTHER_LEGAL_ENTITY,
    orgUnitId: OTHER_ORG_UNIT,
    configurationId: OTHER_CONFIGURATION,
    workflowTemplateId: OTHER_WORKFLOW_TEMPLATE,
    workflowVersionId: OTHER_WORKFLOW_VERSION,
    documentTypeId: OTHER_DOCUMENT_TYPE,
    classificationId: OTHER_CLASSIFICATION,
    documentId: OTHER_DOCUMENT,
    variantId: OTHER_VARIANT,
    label: "B",
  });
  await inCommittedTenant(OTHER_TENANT, async (sql) => {
    await insertVersion(
      sql,
      OTHER_TENANT,
      OTHER_VERSION,
      OTHER_VARIANT,
      OTHER_DOCUMENT_TYPE,
      OTHER_CLASSIFICATION,
      OTHER_CONFIGURATION,
    );
    const bodyDigest = sha256Digest(BODY_BYTES);
    const manifest = buildCanonicalManifest({
      contentRevisionId: OTHER_REVISION,
      contentParts: [{ partId: "body", mediaType: "text/plain", digest: bodyDigest }],
      attachments: [],
    });
    await sql.query(
      `insert into content_revision (
         tenant_id, id, document_version_id, revision_sequence, content_ref,
         canonical_manifest, canonicalisation_schema_version, content_digest, created_by
       ) values ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7)`,
      [
        OTHER_TENANT,
        OTHER_REVISION,
        OTHER_VERSION,
        `t/${OTHER_TENANT}/blob/${bodyDigest.slice("sha-256:".length)}`,
        JSON.stringify(serializeCanonicalManifest(manifest)),
        digestCanonicalManifest(manifest),
        OTHER_USER,
      ],
    );
    await submitContentRevision(transaction(sql), {
      tenantId: OTHER_TENANT,
      documentVersionId: OTHER_VERSION,
      revisionId: OTHER_REVISION,
      expectedVersionRowVersion: 1,
      expectedRevisionRowVersion: 1,
      actor: { type: "USER", id: OTHER_USER },
      configurationVersionId: OTHER_CONFIGURATION,
      occurredAt: FIXED_INSTANT,
      requestId: REQUEST,
      correlationId: CORRELATION,
      sourceChannel: "API",
    });
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

describe("content revisions and governed attachments", () => {
  it("INV-VER-002 / INV-VER-009 / INV-VER-013 / INV-TEN-001 / INV-TEN-003: installs the exact isolated table shapes", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(`
        select c.relname as table_name,
               array_agg(a.attname::text order by a.attname)
                 filter (where a.attnum > 0) as columns,
               c.relrowsecurity as row_security,
               c.relforcerowsecurity as force_row_security,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
         where n.nspname = 'public'
           and c.relname = any(array['content_revision', 'content_attachment'])
         group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
         order by c.relname
      `),
    );
    expect(rows).toEqual([
      {
        table_name: "content_attachment",
        columns: [
          "byte_size",
          "content_revision_id",
          "created_at",
          "digest",
          "filename",
          "id",
          "media_type",
          "row_version",
          "storage_ref",
          "tenant_id",
          "updated_at",
        ],
        row_security: true,
        force_row_security: true,
        policy_count: 1,
      },
      {
        table_name: "content_revision",
        columns: [
          "canonical_manifest",
          "canonicalisation_schema_version",
          "content_digest",
          "content_ref",
          "created_at",
          "created_by",
          "document_version_id",
          "id",
          "revision_sequence",
          "row_version",
          "submitted_at",
          "tenant_id",
          "updated_at",
        ],
        row_security: true,
        force_row_security: true,
        policy_count: 1,
      },
    ]);
    expect(rows[0]?.columns).not.toContain("reference_only");
    expect(rows[0]?.columns).not.toContain("excluded_from_digest");

    const indexes = await withAppRole((sql) =>
      sql.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = 'content_revision'",
      ),
    );
    expect(indexes.rows.map((row) => row.indexname)).not.toContain(
      "one_submitted_revision_per_version",
    );
  });

  it("INV-VER-001 / INV-VER-009: creates a server-measured draft revision without creating a version", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      const expectedBodyDigest = sha256Digest(BODY_BYTES);
      const expectedManifest = buildCanonicalManifest({
        contentRevisionId: REVISION,
        contentParts: [{ partId: "body", mediaType: "text/plain", digest: expectedBodyDigest }],
        attachments: [],
      });
      expect(created).toMatchObject({
        revisionSequence: 1,
        contentRef: `t/${TENANT}/blob/${expectedBodyDigest.slice("sha-256:".length)}`,
        canonicalManifest: serializeCanonicalManifest(expectedManifest),
        canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
        contentDigest: digestCanonicalManifest(expectedManifest),
        rowVersion: 1,
      });

      const revisions = await sql.query<{
        canonical_manifest: string;
        canonicalisation_schema_version: number;
        content_digest: string;
        submitted_at: Date | null;
      }>(
        `select canonical_manifest, canonicalisation_schema_version,
                content_digest, submitted_at
           from content_revision where id = $1`,
        [REVISION],
      );
      expect(revisions.rows).toEqual([
        {
          canonical_manifest: created.canonicalManifest,
          canonicalisation_schema_version: 1,
          content_digest: created.contentDigest,
          submitted_at: null,
        },
      ]);
      const versions = await sql.query<{ count: number }>(
        "select count(*)::int as count from document_version",
      );
      expect(versions.rows).toEqual([{ count: 1 }]);
      const events = await sql.query<{
        event_type: string;
        subject_type: string;
        subject_id: string;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, subject_type, subject_id, safe_after
           from audit_event order by sequence`,
      );
      expect(events.rows).toEqual([
        {
          event_type: "content_revision.created",
          subject_type: "CONTENT_REVISION",
          subject_id: REVISION,
          safe_after: {
            documentVersionId: VERSION,
            revisionSequence: 1,
            canonicalisationSchemaVersion: 1,
            contentDigest: created.contentDigest,
          },
        },
      ]);
    });
  });

  it("INV-VER-009 / INV-VER-013: remeasures bytes and replaces the working manifest after every attachment change", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const added = await addContentAttachment(transaction(sql), {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: ATTACHMENT,
        expectedRevisionRowVersion: created.rowVersion,
        filename: "misleading.pdf",
        bytes: pngBytes,
      });
      expect(added.contentDigest).not.toBe(created.contentDigest);
      expect(added.attachment).toMatchObject({
        filename: "misleading.pdf",
        mediaType: "image/png",
        byteSize: pngBytes.byteLength,
        digest: sha256Digest(pngBytes),
        storageRef: `t/${TENANT}/blob/${sha256Digest(pngBytes).slice("sha-256:".length)}`,
      });
      expect(JSON.parse(added.canonicalManifest).attachments).toEqual([
        {
          byteSize: pngBytes.byteLength,
          digest: sha256Digest(pngBytes),
          filename: "misleading.pdf",
          mediaType: "image/png",
        },
      ]);

      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff]);
      const replaced = await replaceContentAttachment(transaction(sql), {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: ATTACHMENT,
        expectedRevisionRowVersion: added.rowVersion,
        filename: "still-misleading.txt",
        bytes: pdfBytes,
      });
      expect(replaced.contentDigest).not.toBe(added.contentDigest);
      expect(replaced.attachment).toMatchObject({
        filename: "still-misleading.txt",
        mediaType: "application/pdf",
        byteSize: pdfBytes.byteLength,
        digest: sha256Digest(pdfBytes),
      });

      const removed = await removeContentAttachment(transaction(sql), {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: ATTACHMENT,
        expectedRevisionRowVersion: replaced.rowVersion,
      });
      expect(removed.contentDigest).not.toBe(replaced.contentDigest);
      expect(removed.contentDigest).toBe(created.contentDigest);
      expect(removed.canonicalManifest).toBe(created.canonicalManifest);
      const attachments = await sql.query<{ count: number }>(
        "select count(*)::int as count from content_attachment",
      );
      expect(attachments.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-VER-002 / INV-APR-012 / INV-AUD-001: atomically submits and starts the frozen approval run", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      const attachmentBytes = new TextEncoder().encode("governed appendix");
      const added = await addContentAttachment(transaction(sql), {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: ATTACHMENT,
        expectedRevisionRowVersion: created.rowVersion,
        filename: "appendix.bin",
        bytes: attachmentBytes,
      });
      const submitted = await submitRevision(sql, REVISION, added.rowVersion, 1);
      expect(submitted).toMatchObject({
        id: REVISION,
        documentVersionId: VERSION,
        canonicalManifest: added.canonicalManifest,
        contentDigest: added.contentDigest,
        canonicalisationSchemaVersion: 1,
        submittedAt: FIXED_INSTANT,
        rowVersion: added.rowVersion + 1,
        versionRowVersion: 2,
      });
      const rows = await sql.query<{
        submitted_at: Date;
        lifecycle_state: string;
        approved_revision_id: string | null;
      }>(
        `select revision.submitted_at, version.lifecycle_state, version.approved_revision_id
           from content_revision revision
           join document_version version
             on version.tenant_id = revision.tenant_id
            and version.id = revision.document_version_id
          where revision.id = $1`,
        [REVISION],
      );
      expect(rows.rows).toEqual([
        {
          submitted_at: FIXED_INSTANT,
          lifecycle_state: "IN_REVIEW",
          approved_revision_id: null,
        },
      ]);
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event order by sequence",
      );
      expect(events.rows).toEqual([
        { event_type: "content_revision.created" },
        { event_type: "version.submitted" },
        { event_type: "approval_run.started" },
        { event_type: "approval_stage.started" },
        { event_type: "approval_task.assigned" },
      ]);
      const runs = await sql.query<{
        id: string;
        workflow_template_version_id: string;
        resolved_participants: unknown;
        status: string;
        started_at: Date;
        configuration_version_id: string;
      }>(
        `select id, workflow_template_version_id, resolved_participants, status,
                started_at, configuration_version_id
           from approval_run where content_revision_id = $1`,
        [REVISION],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        workflow_template_version_id: WORKFLOW_VERSION,
        resolved_participants: [
          {
            order: 1,
            participants: [{ type: "USER", id: USER, displayName: "A author" }],
          },
          {
            order: 2,
            participants: [{ type: "USER", id: USER, displayName: "A author" }],
          },
        ],
        status: "RUNNING",
        started_at: FIXED_INSTANT,
        configuration_version_id: CONFIGURATION,
      });
      const runId = runs.rows[0]?.id;
      const stages = await sql.query<{
        id: string;
        stage_order: number;
        completion_rule: string;
        threshold: number | null;
        status: string;
        due_at: Date | null;
      }>(
        `select id, stage_order, completion_rule, threshold, status, due_at
           from approval_stage where approval_run_id = $1 order by stage_order`,
        [runId],
      );
      expect(
        stages.rows.map(({ stage_order, completion_rule, threshold, status, due_at }) => ({
          stage_order,
          completion_rule,
          threshold,
          status,
          due_at,
        })),
      ).toEqual([
        {
          stage_order: 1,
          completion_rule: "ALL",
          threshold: null,
          status: "IN_PROGRESS",
          due_at: null,
        },
        {
          stage_order: 2,
          completion_rule: "ALL",
          threshold: null,
          status: "PENDING",
          due_at: null,
        },
      ]);
      const tasks = await sql.query<{
        approval_stage_id: string;
        participant_type: string;
        participant_id: string;
        status: string;
        due_at: Date | null;
      }>(
        `select approval_stage_id, participant_type, participant_id, status, due_at
           from approval_task order by assigned_at`,
      );
      expect(tasks.rows).toEqual([
        {
          approval_stage_id: stages.rows[0]?.id,
          participant_type: "USER",
          participant_id: USER,
          status: "PENDING",
          due_at: null,
        },
      ]);

      const approvalEvents = await sql.query<{
        event_type: string;
        subject_type: string;
        document_id: string;
        document_variant_id: string;
        document_version_id: string;
        actor_type: string;
        actor_id: string;
        occurred_at: Date;
        correlation_id: string;
        configuration_version_id: string;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, subject_type, document_id, document_variant_id,
                document_version_id, actor_type, actor_id, occurred_at,
                correlation_id, configuration_version_id, safe_after
           from audit_event
          where event_type in (
            'approval_run.started', 'approval_stage.started', 'approval_task.assigned'
          )
          order by sequence`,
      );
      expect(approvalEvents.rows).toHaveLength(3);
      expect(
        approvalEvents.rows.map(({ event_type, subject_type }) => ({ event_type, subject_type })),
      ).toEqual([
        { event_type: "approval_run.started", subject_type: "APPROVAL_RUN" },
        { event_type: "approval_stage.started", subject_type: "APPROVAL_STAGE" },
        { event_type: "approval_task.assigned", subject_type: "APPROVAL_TASK" },
      ]);
      for (const event of approvalEvents.rows) {
        expect(event).toMatchObject({
          document_id: DOCUMENT,
          document_variant_id: VARIANT,
          document_version_id: VERSION,
          actor_type: "USER",
          actor_id: USER,
          occurred_at: FIXED_INSTANT,
          correlation_id: CORRELATION,
          configuration_version_id: CONFIGURATION,
        });
      }

      await sql.query(
        `update app_user
            set display_name = 'Renamed after run start', status = 'DEACTIVATED',
                deactivated_at = $2, row_version = row_version + 1
          where id = $1`,
        [USER, FIXED_INSTANT.toISOString()],
      );
      const frozen = await sql.query<{ resolved_participants: unknown }>(
        "select resolved_participants from approval_run where id = $1",
        [runId],
      );
      expect(frozen.rows[0]?.resolved_participants).toEqual(runs.rows[0]?.resolved_participants);
    });
  });

  it("INV-APR-020: an unmet run-start floor rolls back the submission and creates nothing", async () => {
    await withTenant(TENANT, async (sql) => {
      const secondAuthority = "96000000-0000-0000-0001-000000000002";
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Second authority', 'second@authority.example.test', 'ACTIVE')`,
        [TENANT, secondAuthority],
      );
      await sql.query(
        `update document_type
            set mandated_authority = $2::jsonb, row_version = row_version + 1
          where id = $1`,
        [
          DOCUMENT_TYPE,
          JSON.stringify({ MATERIAL: { requires: [{ type: "USER", id: secondAuthority }] } }),
        ],
      );
      await insertVersion(sql);
      const created = await createRevision(sql);

      await expect(submitRevision(sql, REVISION, created.rowVersion, 1)).rejects.toBeInstanceOf(
        WorkflowMandateUnsatisfiedError,
      );
      const state = await sql.query<{
        submitted_at: Date | null;
        lifecycle_state: string;
      }>(
        `select revision.submitted_at, version.lifecycle_state
           from content_revision revision
           join document_version version
             on version.tenant_id = revision.tenant_id
            and version.id = revision.document_version_id
          where revision.id = $1`,
        [REVISION],
      );
      expect(state.rows).toEqual([{ submitted_at: null, lifecycle_state: "DRAFT" }]);
      for (const table of ["approval_run", "approval_stage", "approval_task"]) {
        const rows = await sql.query<{ count: number }>(
          `select count(*)::int as count from ${table}`,
        );
        expect(rows.rows).toEqual([{ count: 0 }]);
      }
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event order by sequence",
      );
      expect(events.rows).toEqual([{ event_type: "content_revision.created" }]);
    });
  });

  it("INV-APR-012: the database permits only one approval run per submitted revision", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      await submitRevision(sql, REVISION, created.rowVersion, 1);
      await expect(
        sql.query(
          `insert into approval_run (
             tenant_id, content_revision_id, workflow_template_version_id,
             resolved_participants, status, started_at, configuration_version_id
           ) values ($1, $2, $3, '[]'::jsonb, 'RUNNING', $4, $5)`,
          [TENANT, REVISION, WORKFLOW_VERSION, FIXED_INSTANT.toISOString(), CONFIGURATION],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "approval_run_content_revision_unique",
      });
    });
  });

  it("INV-APR-012: refuses submission when a named participant is no longer active", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      await sql.query(
        `update app_user
            set status = 'DEACTIVATED', deactivated_at = $2,
                row_version = row_version + 1
          where id = $1`,
        [USER, FIXED_INSTANT.toISOString()],
      );

      await expect(submitRevision(sql, REVISION, created.rowVersion, 1)).rejects.toMatchObject({
        name: WorkflowTemplateValidationError.name,
        code: "PARTICIPANT_NOT_ACTIVE",
      });
      const run = await sql.query<{ count: number }>(
        "select count(*)::int as count from approval_run",
      );
      expect(run.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-TEN-001: another tenant's run, stages and tasks are invisible", async () => {
    await withTenant(TENANT, async (sql) => {
      for (const table of ["approval_run", "approval_stage", "approval_task"]) {
        const rows = await sql.query<{ count: number }>(
          `select count(*)::int as count from ${table}`,
        );
        expect(rows.rows).toEqual([{ count: 0 }]);
      }
    });
  });

  const immutableColumnUpdates = [
    ["tenant_id", `'${OTHER_TENANT}'::uuid`],
    ["id", `'${THIRD_REVISION}'::uuid`],
    ["created_at", "created_at + interval '1 second'"],
    ["updated_at", "updated_at + interval '1 second'"],
    ["row_version", "row_version + 1"],
    ["document_version_id", "gen_random_uuid()"],
    ["revision_sequence", "revision_sequence + 1"],
    ["content_ref", "null"],
    ["canonical_manifest", `'"tampered"'::jsonb`],
    ["canonicalisation_schema_version", "2"],
    ["content_digest", `'sha-256:${"0".repeat(64)}'`],
    ["created_by", "gen_random_uuid()"],
    ["submitted_at", "null"],
  ] as const;

  it.each(immutableColumnUpdates)(
    "INV-VER-010: refuses changing submitted content_revision.%s",
    async (column, expression) => {
      await withTenant(TENANT, async (sql) => {
        await insertVersion(sql);
        const created = await createRevision(sql);
        await submitRevision(sql, REVISION, created.rowVersion, 1);
        await expect(
          sql.query(`update content_revision set ${column} = ${expression} where id = $1`, [
            REVISION,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "content_revision_immutable_after_submission",
        });
      });
    },
  );

  it("INV-VER-002 / INV-VER-010 / INV-VER-013: freezes attachment insertion, update and deletion with the revision", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      const added = await addContentAttachment(transaction(sql), {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: ATTACHMENT,
        expectedRevisionRowVersion: created.rowVersion,
        filename: "frozen.txt",
        bytes: new TextEncoder().encode("frozen"),
      });
      await submitRevision(sql, REVISION, added.rowVersion, 1);

      await expect(
        atSavepoint(sql, "insert_frozen", () =>
          sql.query(
            `insert into content_attachment (
               tenant_id, id, content_revision_id, filename, media_type,
               byte_size, storage_ref, digest
             ) values ($1, $2, $3, 'late.txt', 'text/plain', 1,
                       $4, $5)`,
            [
              TENANT,
              SECOND_ATTACHMENT,
              REVISION,
              `t/${TENANT}/blob/${"1".repeat(64)}`,
              `sha-256:${"1".repeat(64)}`,
            ],
          ),
        ),
      ).rejects.toMatchObject({ constraint: "content_attachment_immutable_after_submission" });
      await expect(
        atSavepoint(sql, "update_frozen", () =>
          sql.query(
            "update content_attachment set filename = 'changed.txt', row_version = row_version + 1 where id = $1",
            [ATTACHMENT],
          ),
        ),
      ).rejects.toMatchObject({ constraint: "content_attachment_immutable_after_submission" });
      await expect(
        atSavepoint(sql, "delete_frozen", () =>
          sql.query("delete from content_attachment where id = $1", [ATTACHMENT]),
        ),
      ).rejects.toMatchObject({ constraint: "content_attachment_immutable_after_submission" });
    });
  });

  it("INV-VER-010: permits resubmission as revision n+1 while both submitted revisions remain byte-exact and immutable", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const first = await createRevision(sql);
      const firstSubmission = await submitRevision(sql, REVISION, first.rowVersion, 1);
      const before = await sql.query<{ snapshot: Record<string, unknown> }>(
        "select to_jsonb(content_revision) as snapshot from content_revision where id = $1",
        [REVISION],
      );
      const changesRequested = await sql.query<{ row_version: number }>(
        `update document_version
            set lifecycle_state = 'CHANGES_REQUESTED', row_version = row_version + 1
          where id = $1 returning row_version`,
        [VERSION],
      );
      expect(changesRequested.rows).toEqual([{ row_version: 3 }]);

      const second = await createRevision(
        sql,
        SECOND_REVISION,
        new TextEncoder().encode("Controlled policy body, revised\n"),
      );
      expect(second).toMatchObject({ revisionSequence: 2, versionRowVersion: 4 });
      const secondSubmission = await submitRevision(
        sql,
        SECOND_REVISION,
        second.rowVersion,
        second.versionRowVersion,
      );
      expect(secondSubmission.contentDigest).not.toBe(firstSubmission.contentDigest);
      const after = await sql.query<{ snapshot: Record<string, unknown> }>(
        "select to_jsonb(content_revision) as snapshot from content_revision where id = $1",
        [REVISION],
      );
      expect(after.rows).toEqual(before.rows);
      const submitted = await sql.query<{
        id: string;
        revision_sequence: number;
        submitted_at: Date;
      }>(
        `select id, revision_sequence, submitted_at
           from content_revision where submitted_at is not null order by revision_sequence`,
      );
      expect(submitted.rows).toEqual([
        { id: REVISION, revision_sequence: 1, submitted_at: FIXED_INSTANT },
        { id: SECOND_REVISION, revision_sequence: 2, submitted_at: FIXED_INSTANT },
      ]);
      for (const [index, revisionId] of [REVISION, SECOND_REVISION].entries()) {
        await expect(
          atSavepoint(sql, `frozen_${index}`, () =>
            sql.query("update content_revision set row_version = row_version + 1 where id = $1", [
              revisionId,
            ]),
          ),
        ).rejects.toMatchObject({
          constraint: "content_revision_immutable_after_submission",
        });
      }
    });
  });

  it("INV-VER-004: refuses creating or editing content while the version is IN_REVIEW", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const submittedCandidate = await createRevision(sql);
      const otherDraft = await createRevision(
        sql,
        SECOND_REVISION,
        new TextEncoder().encode("Alternative draft"),
      );
      await submitRevision(sql, REVISION, submittedCandidate.rowVersion, 1);

      await expect(
        createRevision(sql, THIRD_REVISION, new TextEncoder().encode("Late draft")),
      ).rejects.toBeInstanceOf(ContentRevisionLifecycleError);
      await expect(
        addContentAttachment(transaction(sql), {
          tenantId: TENANT,
          revisionId: SECOND_REVISION,
          attachmentId: ATTACHMENT,
          expectedRevisionRowVersion: otherDraft.rowVersion,
          filename: "late.txt",
          bytes: new TextEncoder().encode("late attachment"),
        }),
      ).rejects.toBeInstanceOf(ContentRevisionLifecycleError);
      const revisions = await sql.query<{ count: number }>(
        "select count(*)::int as count from content_revision",
      );
      expect(revisions.rows).toEqual([{ count: 2 }]);
    });
  });

  it("INV-TEN-001: a cross-tenant revision identifier is indistinguishable from not-found", async () => {
    await withTenant(TENANT, async (sql) => {
      const visible = await sql.query("select id from content_revision where id = $1", [
        OTHER_REVISION,
      ]);
      expect(visible.rows).toEqual([]);
      await expect(
        addContentAttachment(transaction(sql), {
          tenantId: TENANT,
          revisionId: OTHER_REVISION,
          attachmentId: ATTACHMENT,
          expectedRevisionRowVersion: 1,
          filename: "probe.txt",
          bytes: new TextEncoder().encode("probe"),
        }),
      ).rejects.toBeInstanceOf(ContentRevisionNotFoundError);
    });
  });

  it("app_role cannot delete or truncate the retained content-revision trail", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      await createRevision(sql);
      await expect(
        sql.query("delete from content_revision where id = $1", [REVISION]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await withTenant(TENANT, async (sql) => {
      await expect(sql.query("truncate content_revision")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  it("INV-TEN-003 / INV-DOC-004 / INV-VER-002: enforces the approved-revision foreign key with restrict semantics", async () => {
    const constraints = await withAppRole((sql) =>
      sql.query<{ name: string; delete_action: string; validated: boolean }>(`
        select conname as name, confdeltype::text as delete_action, convalidated as validated
          from pg_constraint
         where conrelid = 'document_version'::regclass
           and conname = 'document_version_approved_revision_fk'
      `),
    );
    expect(constraints.rows).toEqual([
      {
        name: "document_version_approved_revision_fk",
        delete_action: "r",
        validated: true,
      },
    ]);
    await withTenant(TENANT, async (sql) => {
      await insertVersion(sql);
      const created = await createRevision(sql);
      const accepted = await sql.query<{ approved_revision_id: string }>(
        `update document_version
            set approved_revision_id = $2, row_version = row_version + 1
          where id = $1
          returning approved_revision_id`,
        [VERSION, created.id],
      );
      expect(accepted.rows).toEqual([{ approved_revision_id: REVISION }]);
      await expect(
        sql.query(
          "update document_version set approved_revision_id = $2, row_version = row_version + 1 where id = $1",
          [VERSION, OTHER_REVISION],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "document_version_approved_revision_fk",
      });
    });
  });

  it("documents every content constraint with the invariant identifiers it enforces", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ name: string; comment: string | null }>(`
        select con.conname as name, obj_description(con.oid, 'pg_constraint')::text as comment
          from pg_constraint con
         where con.conrelid = any(array[
           'content_revision'::regclass,
           'content_attachment'::regclass
         ])
           and con.contype <> 'n'
         order by con.conname
      `),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.comment, row.name).toMatch(/INV-[A-Z]+-[0-9]{3}/);
  });
});
