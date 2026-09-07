import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DocumentVersionConcurrencyError,
  DocumentVersionLifecycleError,
  DocumentVersionNotFoundError,
  DocumentVersionScheduleConflictError,
  publishDocumentVersion,
  resolveEffectiveVersion,
  transitionDocumentVersionEffective,
  withdrawDocumentVersion,
  type AuditTransaction,
  type PublishDocumentVersionInput,
  type TransitionDocumentVersionEffectiveInput,
} from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  withoutTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "97000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "98000000-0000-0000-0000-000000000002";
const USER = "97000000-0000-0000-0001-000000000001";
const OTHER_USER = "98000000-0000-0000-0001-000000000002";
const ORG = "97000000-0000-0000-0002-000000000001";
const OTHER_ORG = "98000000-0000-0000-0002-000000000002";
const ENTITY = "97000000-0000-0000-0003-000000000001";
const OTHER_ENTITY = "98000000-0000-0000-0003-000000000002";
const CONFIGURATION = "97000000-0000-0000-0004-000000000001";
const OTHER_CONFIGURATION = "98000000-0000-0000-0004-000000000002";
const DOCUMENT_TYPE = "97000000-0000-0000-0005-000000000001";
const OTHER_DOCUMENT_TYPE = "98000000-0000-0000-0005-000000000002";
const CLASSIFICATION = "97000000-0000-0000-0006-000000000001";
const OTHER_CLASSIFICATION = "98000000-0000-0000-0006-000000000002";
const DOCUMENT = "97000000-0000-0000-0007-000000000001";
const OTHER_DOCUMENT = "98000000-0000-0000-0007-000000000002";
const BASELINE = "97000000-0000-0000-0008-000000000001";
const OTHER_BASELINE = "98000000-0000-0000-0008-000000000002";
const OTHER_VERSION = "98000000-0000-0000-0009-000000000002";

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function publicationInput(
  versionId: string,
  rowVersion: number,
  occurredAt: Date,
  effectiveFrom: Date,
): PublishDocumentVersionInput {
  return {
    tenantId: TENANT,
    versionId,
    expectedRowVersion: rowVersion,
    effectiveFrom,
    actor: { type: "USER", id: USER },
    configurationVersionId: CONFIGURATION,
    occurredAt,
    requestId: randomUUID(),
    correlationId: randomUUID(),
    sourceChannel: "API",
  };
}

async function committedTenant<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
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

interface TenantSeed {
  tenantId: string;
  userId: string;
  entityId: string;
  orgId: string;
  configurationId: string;
  documentTypeId: string;
  classificationId: string;
  documentId: string;
  baselineId: string;
  label: string;
}

async function seedTenant(seed: TenantSeed): Promise<void> {
  await committedTenant(seed.tenantId, async (sql) => {
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [seed.tenantId, seed.userId, `${seed.label} publisher`, `${seed.label}@example.test`],
    );
    await sql.query(
      `insert into legal_entity
         (tenant_id, id, legal_name, country_of_registration, status)
       values ($1, $2, $3, 'EE', 'ACTIVE')`,
      [seed.tenantId, seed.entityId, `${seed.label} OÜ`],
    );
    await sql.query(
      `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
       values ($1, $2, 'Compliance', $3, $4, 'ACTIVE')`,
      [seed.tenantId, seed.orgId, `PUB_${seed.label}`, seed.entityId],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, now(), $3, 'Publication test configuration', false, $4)`,
      [seed.tenantId, seed.configurationId, seed.userId, `sha256:publication-${seed.label}`],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority,
         default_review_rule, requires_attestation_by_default, status
       ) values ($1, $2, $3, 'Policy', 10, '{}'::jsonb, '{}'::jsonb, false, 'ACTIVE')`,
      [seed.tenantId, seed.documentTypeId, `PUB_${seed.label}`],
    );
    await sql.query(
      `insert into information_classification (
         tenant_id, id, code, name, rank, handling_instructions,
         externally_disclosable, status
       ) values ($1, $2, $3, 'Internal', 10, 'Internal use', false, 'ACTIVE')`,
      [seed.tenantId, seed.classificationId, `PUB_${seed.label}`],
    );
    await sql.query(
      `insert into document (
         tenant_id, id, document_code, canonical_title, document_type_id,
         owning_org_unit_id, lifecycle_status, is_governing_framework
       ) values ($1, $2, $3, $4, $5, $6, 'PLANNED', false)`,
      [
        seed.tenantId,
        seed.documentId,
        `PUB-${seed.label}`,
        `${seed.label} Publication Policy`,
        seed.documentTypeId,
        seed.orgId,
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

async function addVariant(sql: Sql, variantId: string): Promise<void> {
  await sql.query(
    `insert into document_variant
       (tenant_id, id, document_id, variant_type, source_variant_id, status)
     values ($1, $2, $3, 'SUPPLEMENT', $4, 'ACTIVE')`,
    [TENANT, variantId, DOCUMENT, BASELINE],
  );
}

async function addPlannedDocument(
  sql: Sql,
  documentId: string,
  baselineVariantId: string,
): Promise<void> {
  await sql.query(
    `insert into document (
       tenant_id, id, document_code, canonical_title, document_type_id,
       owning_org_unit_id, lifecycle_status, is_governing_framework
     ) values ($1, $2, $3, 'Scheduled activation policy', $4, $5, 'PLANNED', false)`,
    [TENANT, documentId, `EFF-${documentId.slice(-8)}`, DOCUMENT_TYPE, ORG],
  );
  await sql.query(
    `insert into document_variant
       (tenant_id, id, document_id, variant_type, status)
     values ($1, $2, $3, 'BASELINE', 'ACTIVE')`,
    [TENANT, baselineVariantId, documentId],
  );
}

async function addApprovedVersion(
  sql: Sql,
  versionId: string,
  variantId: string,
  sequence = 1,
): Promise<number> {
  await sql.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
       document_type_id, title, classification_id, materiality, configuration_version_id
     ) values ($1, $2, $3, $4, 'DRAFT', $5, 'Publication Policy', $6,
               'MATERIAL', $7)`,
    [TENANT, versionId, variantId, sequence, DOCUMENT_TYPE, CLASSIFICATION, CONFIGURATION],
  );
  for (const lifecycle of ["IN_REVIEW", "APPROVED"] as const) {
    await sql.query(
      `update document_version
          set lifecycle_state = $2::version_lifecycle,
              row_version = row_version + 1
        where tenant_id = $1 and id = $3`,
      [TENANT, lifecycle, versionId],
    );
  }
  return 3;
}

async function addOtherTenantApprovedVersion(): Promise<void> {
  await committedTenant(OTHER_TENANT, async (sql) => {
    await sql.query(
      `insert into document_version (
         tenant_id, id, document_variant_id, version_sequence, lifecycle_state,
         document_type_id, title, classification_id, materiality, configuration_version_id
       ) values ($1, $2, $3, 1, 'DRAFT', $4, 'Other Policy', $5, 'MATERIAL', $6)`,
      [
        OTHER_TENANT,
        OTHER_VERSION,
        OTHER_BASELINE,
        OTHER_DOCUMENT_TYPE,
        OTHER_CLASSIFICATION,
        OTHER_CONFIGURATION,
      ],
    );
    for (const lifecycle of ["IN_REVIEW", "APPROVED"] as const) {
      await sql.query(
        `update document_version
            set lifecycle_state = $2::version_lifecycle,
                row_version = row_version + 1
          where tenant_id = $1 and id = $3`,
        [OTHER_TENANT, lifecycle, OTHER_VERSION],
      );
    }
  });
}

beforeAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT);
    await clearTenant(sql, OTHER_TENANT);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Publication tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other publication tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
  });
  await seedTenant({
    tenantId: TENANT,
    userId: USER,
    entityId: ENTITY,
    orgId: ORG,
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
    entityId: OTHER_ENTITY,
    orgId: OTHER_ORG,
    configurationId: OTHER_CONFIGURATION,
    documentTypeId: OTHER_DOCUMENT_TYPE,
    classificationId: OTHER_CLASSIFICATION,
    documentId: OTHER_DOCUMENT,
    baselineId: OTHER_BASELINE,
    label: "B",
  });
  await addOtherTenantApprovedVersion();
});

afterAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT);
    await clearTenant(sql, OTHER_TENANT);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
  });
});

describe("publication, supersession, withdrawal and resolution", () => {
  it("INV-EFF-001 / INV-EFF-006: claims a future interval without making lifecycle state normative", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      const publishedAt = new Date();
      const effectiveFrom = new Date(publishedAt.valueOf() + 86_400_000);
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(versionId, rowVersion, publishedAt, effectiveFrom),
      );

      expect(published).toMatchObject({
        lifecycleState: "PUBLISHED",
        immediate: false,
        effectiveUntil: null,
      });
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: publishedAt,
        }),
      ).toBeNull();
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: effectiveFrom,
        }),
      ).toMatchObject({ id: versionId, lifecycleState: "PUBLISHED" });
    });
  });

  it("INV-EFF-002: refuses a second publication at the same instant with the named collision", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      await addVariant(sql, variantId);
      const firstRowVersion = await addApprovedVersion(sql, firstId, variantId, 1);
      const publishedAt = new Date();
      const effectiveFrom = new Date(publishedAt.valueOf() + 86_400_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(firstId, firstRowVersion, publishedAt, effectiveFrom),
      );
      const secondRowVersion = await addApprovedVersion(sql, secondId, variantId, 2);

      await sql.query("savepoint duplicate_instant");
      const collision = await publishDocumentVersion(
        transaction(sql),
        publicationInput(secondId, secondRowVersion, publishedAt, effectiveFrom),
      ).catch((error: unknown) => error);
      expect(collision).toBeInstanceOf(DocumentVersionScheduleConflictError);
      expect(collision).toMatchObject({ constraint: "one_effective_version_per_variant" });
      await sql.query("rollback to savepoint duplicate_instant");
      await sql.query("release savepoint duplicate_instant");

      const first = await sql.query<{ empty: boolean; effective_until: Date | null }>(
        `select isempty(effective_range) as empty, effective_until
           from document_version where id = $1`,
        [firstId],
      );
      expect(first.rows).toEqual([{ empty: false, effective_until: null }]);
    });
  });

  it("INV-DOC-007 / INV-AUD-004 / INV-EFF-001: records immediate publication, effectivity and derived activation in order", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      const now = new Date(Date.now() - 1_000);
      const input = publicationInput(versionId, rowVersion, now, now);
      const published = await publishDocumentVersion(transaction(sql), input);

      expect(published).toMatchObject({
        lifecycleState: "EFFECTIVE",
        immediate: true,
        documentActivated: true,
      });
      const document = await sql.query<{ lifecycle_status: string }>(
        "select lifecycle_status from document where tenant_id = $1 and id = $2",
        [TENANT, DOCUMENT],
      );
      expect(document.rows).toEqual([{ lifecycle_status: "ACTIVE" }]);
      const ordered = await sql.query<{ event_type: string }>(
        `select event_type from audit_event
          where correlation_id = $1 order by sequence`,
        [input.correlationId],
      );
      expect(ordered.rows.map((row) => row.event_type)).toEqual([
        "version.published",
        "version.effective",
        "document.activated",
      ]);
    });
  });

  it("INV-EFF-003 / INV-TIME-005: closes a predecessor atomically and resolves both sides of the boundary", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      await addVariant(sql, variantId);
      const firstRowVersion = await addApprovedVersion(sql, firstId, variantId, 1);
      const firstAt = new Date(Date.now() - 60_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(firstId, firstRowVersion, firstAt, firstAt),
      );
      const secondRowVersion = await addApprovedVersion(sql, secondId, variantId, 2);
      const secondAt = new Date();
      const secondInput = publicationInput(secondId, secondRowVersion, secondAt, secondAt);
      await publishDocumentVersion(transaction(sql), secondInput);

      const versions = await sql.query<{
        id: string;
        lifecycle_state: string;
        effective_until: Date | null;
        superseded_by_version_id: string | null;
      }>(
        `select id, lifecycle_state, effective_until, superseded_by_version_id
           from document_version where document_variant_id = $1 order by version_sequence`,
        [variantId],
      );
      expect(versions.rows).toEqual([
        {
          id: firstId,
          lifecycle_state: "SUPERSEDED",
          effective_until: secondAt,
          superseded_by_version_id: secondId,
        },
        {
          id: secondId,
          lifecycle_state: "EFFECTIVE",
          effective_until: null,
          superseded_by_version_id: null,
        },
      ]);
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: new Date(secondAt.valueOf() - 1),
        }),
      ).toMatchObject({ id: firstId });
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: secondAt,
        }),
      ).toMatchObject({ id: secondId });
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [secondInput.correlationId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "version.published",
        "version.superseded",
        "version.effective",
      ]);
    });
  });

  it("INV-EFF-004: withdraws a PUBLISHED version to an empty range with the server instant and reason", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const laterVersionId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const publishedAt = new Date();
      const effectiveFrom = new Date(publishedAt.valueOf() + 86_400_000);
      const laterEffectiveFrom = new Date(effectiveFrom.valueOf() + 86_400_000);
      const laterRowVersion = await addApprovedVersion(sql, laterVersionId, variantId, 1);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(laterVersionId, laterRowVersion, publishedAt, laterEffectiveFrom),
      );
      const approvedRowVersion = await addApprovedVersion(sql, versionId, variantId, 2);
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(versionId, approvedRowVersion, publishedAt, effectiveFrom),
      );
      const withdrawn = await withdrawDocumentVersion(transaction(sql), {
        ...publicationInput(versionId, published.rowVersion, publishedAt, effectiveFrom),
        withdrawalReason: "Published in error",
      });

      expect(withdrawn.lifecycleState).toBe("WITHDRAWN");
      expect(withdrawn.previousEffectiveUntil).toEqual(laterEffectiveFrom);
      expect(withdrawn.effectiveUntil).toEqual(effectiveFrom);
      expect(withdrawn.withdrawnAt.valueOf()).toBeLessThan(effectiveFrom.valueOf());
      const stored = await sql.query<{ empty: boolean; withdrawal_reason: string }>(
        `select isempty(effective_range) as empty, withdrawal_reason
           from document_version where id = $1`,
        [versionId],
      );
      expect(stored.rows).toEqual([{ empty: true, withdrawal_reason: "Published in error" }]);
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: effectiveFrom,
        }),
      ).toBeNull();
      const event = await sql.query<{ safe_after: Record<string, unknown> }>(
        "select safe_after from audit_event where event_type = 'version.withdrawn' and document_version_id = $1",
        [versionId],
      );
      expect(event.rows[0]?.safe_after).toMatchObject({ withdrawalReason: "Published in error" });

      const replacementId = randomUUID();
      const replacementRowVersion = await addApprovedVersion(sql, replacementId, variantId, 3);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(replacementId, replacementRowVersion, publishedAt, effectiveFrom),
      );
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: effectiveFrom,
        }),
      ).toMatchObject({ id: replacementId });
    });
  });

  it("INV-EFF-004 / INV-VER-007: shortens a prospective effective upper bound at transaction time without resurrecting history", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const predecessorId = randomUUID();
      const currentId = randomUUID();
      const successorId = randomUUID();
      await addVariant(sql, variantId);
      const predecessorAt = new Date(Date.now() - 120_000);
      const predecessorRowVersion = await addApprovedVersion(sql, predecessorId, variantId, 1);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(predecessorId, predecessorRowVersion, predecessorAt, predecessorAt),
      );
      const currentAt = new Date(Date.now() - 60_000);
      const currentRowVersion = await addApprovedVersion(sql, currentId, variantId, 2);
      const current = await publishDocumentVersion(
        transaction(sql),
        publicationInput(currentId, currentRowVersion, currentAt, currentAt),
      );
      const successorRowVersion = await addApprovedVersion(sql, successorId, variantId, 3);
      const futureAt = new Date(Date.now() + 86_400_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(successorId, successorRowVersion, new Date(), futureAt),
      );
      const beforeWithdrawal = await sql.query<{ row_version: number }>(
        "select row_version from document_version where id = $1",
        [currentId],
      );
      const withdrawn = await withdrawDocumentVersion(transaction(sql), {
        tenantId: TENANT,
        versionId: currentId,
        expectedRowVersion: beforeWithdrawal.rows[0]!.row_version,
        withdrawalReason: "Emergency correction",
        actor: { type: "USER", id: USER },
        configurationVersionId: CONFIGURATION,
        occurredAt: new Date(),
        requestId: randomUUID(),
        correlationId: randomUUID(),
        sourceChannel: "API",
      });

      expect(withdrawn.previousLifecycleState).toBe("EFFECTIVE");
      expect(withdrawn.previousEffectiveUntil).toEqual(futureAt);
      expect(withdrawn.effectiveUntil).toEqual(withdrawn.withdrawnAt);
      expect(withdrawn.effectiveUntil.valueOf()).toBeLessThan(futureAt.valueOf());
      expect(withdrawn.policyGapEvent).not.toBeNull();
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: new Date(withdrawn.withdrawnAt.valueOf() + 1),
        }),
      ).toBeNull();
      const predecessor = await sql.query<{ lifecycle_state: string }>(
        "select lifecycle_state from document_version where id = $1",
        [predecessorId],
      );
      expect(predecessor.rows).toEqual([{ lifecycle_state: "SUPERSEDED" }]);
      const gaps = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'governance.policy_gap' and document_version_id = $1`,
        [currentId],
      );
      expect(gaps.rows).toEqual([{ count: 1 }]);
      expect(current.lifecycleState).toBe("EFFECTIVE");
    });
  });

  it("INV-VER-007: refuses publication that would move an already-set predecessor bound", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const firstId = randomUUID();
      const laterId = randomUUID();
      const betweenId = randomUUID();
      await addVariant(sql, variantId);
      const firstAt = new Date(Date.now() - 60_000);
      const firstRowVersion = await addApprovedVersion(sql, firstId, variantId, 1);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(firstId, firstRowVersion, firstAt, firstAt),
      );

      const laterAt = new Date(Date.now() + 86_400_000);
      const laterRowVersion = await addApprovedVersion(sql, laterId, variantId, 2);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(laterId, laterRowVersion, new Date(), laterAt),
      );

      const betweenAt = new Date(Date.now() + 43_200_000);
      const betweenRowVersion = await addApprovedVersion(sql, betweenId, variantId, 3);
      await sql.query("savepoint immutable_predecessor");
      await expect(
        publishDocumentVersion(
          transaction(sql),
          publicationInput(betweenId, betweenRowVersion, new Date(), betweenAt),
        ),
      ).rejects.toMatchObject({
        constraint: "document_version_governed_columns_immutable",
      });
      await sql.query("rollback to savepoint immutable_predecessor");
      await sql.query("release savepoint immutable_predecessor");
    });
  });

  it("INV-VER-007: refuses direct changes to starts and arbitrary upper-bound rewrites", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      const now = new Date();
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(versionId, rowVersion, now, now),
      );
      for (const [label, assignment, value] of [
        ["start", "effective_from", new Date(now.valueOf() + 1_000)],
        ["later", "effective_until", new Date(now.valueOf() + 86_400_000)],
        ["past", "effective_until", new Date(now.valueOf() - 86_400_000)],
      ] as const) {
        await sql.query(`savepoint "immutable_${label}"`);
        await expect(
          sql.query(
            `update document_version set ${assignment} = $1 where tenant_id = $2 and id = $3`,
            [value, TENANT, versionId],
          ),
        ).rejects.toMatchObject({ constraint: "document_version_governed_columns_immutable" });
        await sql.query(`rollback to savepoint "immutable_${label}"`);
        await sql.query(`release savepoint "immutable_${label}"`);
      }
      expect(published.effectiveFrom).toEqual(now);
    });
  });

  it("INV-VER-007: the trigger itself refuses arbitrary withdrawal bounds under owner execution", async () => {
    await withMigrationRole__PRIVILEGED(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);

        const publishedVariantId = randomUUID();
        const publishedVersionId = randomUUID();
        await addVariant(sql, publishedVariantId);
        const publishedRowVersion = await addApprovedVersion(
          sql,
          publishedVersionId,
          publishedVariantId,
        );
        const publishedAt = new Date();
        const futureAt = new Date(publishedAt.valueOf() + 86_400_000);
        const published = await publishDocumentVersion(
          transaction(sql),
          publicationInput(publishedVersionId, publishedRowVersion, publishedAt, futureAt),
        );
        await sql.query("savepoint invalid_published_withdrawal");
        await expect(
          sql.query(
            `update document_version
                set lifecycle_state = 'WITHDRAWN',
                    effective_until = $1,
                    withdrawn_at = transaction_timestamp(),
                    withdrawal_reason = 'Invalid bound',
                    row_version = row_version + 1
              where id = $2`,
            [new Date(futureAt.valueOf() + 3_600_000), published.id],
          ),
        ).rejects.toMatchObject({ constraint: "document_version_governed_columns_immutable" });
        await sql.query("rollback to savepoint invalid_published_withdrawal");
        await sql.query("release savepoint invalid_published_withdrawal");

        const effectiveVariantId = randomUUID();
        const effectiveVersionId = randomUUID();
        await addVariant(sql, effectiveVariantId);
        const effectiveRowVersion = await addApprovedVersion(
          sql,
          effectiveVersionId,
          effectiveVariantId,
        );
        const effectiveAt = new Date(Date.now() - 1_000);
        const effective = await publishDocumentVersion(
          transaction(sql),
          publicationInput(effectiveVersionId, effectiveRowVersion, effectiveAt, effectiveAt),
        );
        await sql.query("savepoint invalid_effective_withdrawal");
        await expect(
          sql.query(
            `update document_version
                set lifecycle_state = 'WITHDRAWN',
                    effective_until = effective_from,
                    withdrawn_at = transaction_timestamp(),
                    withdrawal_reason = 'Retroactive bound',
                    row_version = row_version + 1
              where id = $1`,
            [effective.id],
          ),
        ).rejects.toMatchObject({ constraint: "document_version_governed_columns_immutable" });
        await sql.query("rollback to savepoint invalid_effective_withdrawal");
        await sql.query("release savepoint invalid_effective_withdrawal");
      } finally {
        await sql.query("rollback");
      }
    });
  });

  it("INV-EFF-004 / INV-TIME-003: refuses blank reasons, stale writes and unsupported lifecycle shortcuts", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      await expect(
        withdrawDocumentVersion(transaction(sql), {
          ...publicationInput(versionId, rowVersion, new Date(), new Date()),
          withdrawalReason: "   ",
        }),
      ).rejects.toThrow(/reason is required/i);
      await sql.query("savepoint stale_publication");
      await expect(
        publishDocumentVersion(
          transaction(sql),
          publicationInput(versionId, rowVersion - 1, new Date(), new Date()),
        ),
      ).rejects.toBeInstanceOf(DocumentVersionConcurrencyError);
      await sql.query("rollback to savepoint stale_publication");
      await sql.query("release savepoint stale_publication");

      await sql.query(
        `update document_version
            set lifecycle_state = 'CANCELLED', row_version = row_version + 1
          where id = $1`,
        [versionId],
      );
      const cancelled = await sql.query<{ row_version: number }>(
        "select row_version from document_version where id = $1",
        [versionId],
      );
      await expect(
        publishDocumentVersion(
          transaction(sql),
          publicationInput(versionId, cancelled.rows[0]!.row_version, new Date(), new Date()),
        ),
      ).rejects.toBeInstanceOf(DocumentVersionLifecycleError);
    });
  });

  it("INV-EFF-006: resolves a stale PUBLISHED state historically through the same query", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addVariant(sql, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      const publishedAt = new Date(Date.now() - 60_000);
      const effectiveFrom = new Date(Date.now() + 60_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(versionId, rowVersion, publishedAt, effectiveFrom),
      );
      const historical = new Date(effectiveFrom.valueOf() + 1);
      const resolved = await resolveEffectiveVersion(transaction(sql), {
        tenantId: TENANT,
        documentVariantId: variantId,
        at: historical,
      });
      expect(resolved).toMatchObject({ id: versionId, lifecycleState: "PUBLISHED" });
    });
  });

  it("INV-TEN-001 / INV-TEN-003: fails closed without tenant context and hides cross-tenant versions", async () => {
    await withoutTenant(async (sql) => {
      await expect(
        publishDocumentVersion(
          transaction(sql),
          publicationInput(randomUUID(), 3, new Date(), new Date()),
        ),
      ).rejects.toThrow();
    });
    await withTenant(TENANT, async (sql) => {
      await expect(
        publishDocumentVersion(
          transaction(sql),
          publicationInput(OTHER_VERSION, 3, new Date(), new Date()),
        ),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundError);
    });
  });

  it("INV-DOC-007: refuses app_role setting ACTIVE directly", async () => {
    await withTenant(TENANT, async (sql) => {
      await expect(
        sql.query("update document set lifecycle_status = 'ACTIVE' where id = $1", [DOCUMENT]),
      ).rejects.toMatchObject({ constraint: "document_lifecycle_transition" });
    });
  });

  it("installs narrow SECURITY DEFINER publication entry points owned by migration_role", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        proname: string;
        owner: string;
        prosecdef: boolean;
        proconfig: string[];
        acl: string;
      }>(`
        select proc.proname,
               pg_get_userbyid(proc.proowner) as owner,
               proc.prosecdef,
               proc.proconfig,
               proc.proacl::text as acl
          from pg_proc proc
          join pg_namespace namespace on namespace.oid = proc.pronamespace
         where namespace.nspname = 'public'
           and proc.proname in ('publish_document_version', 'withdraw_document_version')
         order by proc.proname
      `),
    );
    expect(rows).toEqual([
      {
        proname: "publish_document_version",
        owner: "migration_role",
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, public"],
        acl: "{migration_role=X/migration_role,app_role=X/migration_role}",
      },
      {
        proname: "withdraw_document_version",
        owner: "migration_role",
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, public"],
        acl: "{migration_role=X/migration_role,app_role=X/migration_role}",
      },
    ]);
  });
});

describe("publication transaction concurrency", () => {
  async function concurrentPublish(input: PublishDocumentVersionInput): Promise<unknown> {
    return withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        const result = await publishDocumentVersion(transaction(sql), input);
        await sql.query("commit");
        return result;
      } catch (error) {
        await sql.query("rollback");
        return error;
      }
    });
  }

  it("INV-EFF-002 / INV-TIME-003: allows exactly one concurrent publication on one variant", async () => {
    const variantId = randomUUID();
    const versionId = randomUUID();
    await committedTenant(TENANT, async (sql) => {
      await addVariant(sql, variantId);
      await addApprovedVersion(sql, versionId, variantId);
    });
    const publishedAt = new Date();
    const effectiveFrom = new Date(publishedAt.valueOf() + 86_400_000);
    const results = await Promise.all([
      concurrentPublish(publicationInput(versionId, 3, publishedAt, effectiveFrom)),
      concurrentPublish(publicationInput(versionId, 3, publishedAt, effectiveFrom)),
    ]);
    expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1);
    expect(results.filter((result) => result instanceof Error)).toHaveLength(1);
  });

  it("INV-EFF-002: permits concurrent publications on different variants of one document", async () => {
    const firstVariant = randomUUID();
    const secondVariant = randomUUID();
    const firstVersion = randomUUID();
    const secondVersion = randomUUID();
    await committedTenant(TENANT, async (sql) => {
      await addVariant(sql, firstVariant);
      await addVariant(sql, secondVariant);
      await addApprovedVersion(sql, firstVersion, firstVariant);
      await addApprovedVersion(sql, secondVersion, secondVariant);
    });
    const publishedAt = new Date();
    const effectiveFrom = new Date(publishedAt.valueOf() + 86_400_000);
    const results = await Promise.all([
      concurrentPublish(publicationInput(firstVersion, 3, publishedAt, effectiveFrom)),
      concurrentPublish(publicationInput(secondVersion, 3, publishedAt, effectiveFrom)),
    ]);
    expect(results.every((result) => !(result instanceof Error))).toBe(true);
  });

  it("INV-EFF-003 / INV-AUD-004: rollback leaves neither the interval nor its event", async () => {
    const variantId = randomUUID();
    const predecessorId = randomUUID();
    const successorId = randomUUID();
    await committedTenant(TENANT, async (sql) => {
      await addVariant(sql, variantId);
      const predecessorRowVersion = await addApprovedVersion(sql, predecessorId, variantId, 1);
      const predecessorAt = new Date(Date.now() - 60_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(predecessorId, predecessorRowVersion, predecessorAt, predecessorAt),
      );
      await addApprovedVersion(sql, successorId, variantId, 2);
    });
    await withTenant(TENANT, async (sql) => {
      const publishedAt = new Date();
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(successorId, 3, publishedAt, new Date(publishedAt.valueOf() + 86_400_000)),
      );
    });
    await withTenant(TENANT, async (sql) => {
      const versions = await sql.query<{
        id: string;
        lifecycle_state: string;
        effective_from: Date | null;
        effective_until: Date | null;
      }>(
        `select id, lifecycle_state, effective_from, effective_until
           from document_version where id = any($1::uuid[]) order by version_sequence`,
        [[predecessorId, successorId]],
      );
      expect(versions.rows).toEqual([
        {
          id: predecessorId,
          lifecycle_state: "EFFECTIVE",
          effective_from: expect.any(Date),
          effective_until: null,
        },
        {
          id: successorId,
          lifecycle_state: "APPROVED",
          effective_from: null,
          effective_until: null,
        },
      ]);
      const events = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where document_version_id = $1",
        [successorId],
      );
      expect(events.rows).toEqual([{ count: 0 }]);
    });
  });
});

function effectivityInput(
  versionId: string,
  instant: Date,
  overrides: Partial<TransitionDocumentVersionEffectiveInput> = {},
): TransitionDocumentVersionEffectiveInput {
  return {
    tenantId: TENANT,
    versionId,
    instant,
    requestId: randomUUID(),
    correlationId: randomUUID(),
    sourceChannel: "JOB",
    ...overrides,
  };
}

async function addCommittedScheduledVersion(
  variantId: string,
  versionId: string,
): Promise<{ effectiveFrom: Date; rowVersion: number }> {
  return committedTenant(TENANT, async (sql) => {
    await addVariant(sql, variantId);
    const rowVersion = await addApprovedVersion(sql, versionId, variantId);
    const publishedAt = new Date(Date.now() - 120_000);
    const effectiveFrom = new Date(Date.now() - 60_000);
    const published = await publishDocumentVersion(
      transaction(sql),
      publicationInput(versionId, rowVersion, publishedAt, effectiveFrom),
    );
    return { effectiveFrom, rowVersion: published.rowVersion };
  });
}

describe("effective-instant lifecycle narration", () => {
  it("INV-DOC-007 / INV-EFF-007 / INV-AUD-001 / INV-AUD-004: makes the first scheduled version effective and activates its document exactly once", async () => {
    await withTenant(TENANT, async (sql) => {
      const documentId = randomUUID();
      const variantId = randomUUID();
      const versionId = randomUUID();
      await addPlannedDocument(sql, documentId, variantId);
      const rowVersion = await addApprovedVersion(sql, versionId, variantId);
      const publishedAt = new Date(Date.now() - 120_000);
      const effectiveFrom = new Date(Date.now() - 60_000);
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(versionId, rowVersion, publishedAt, effectiveFrom),
      );

      expect(published.lifecycleState).toBe("PUBLISHED");
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: effectiveFrom,
        }),
      ).toMatchObject({ id: versionId, lifecycleState: "PUBLISHED" });

      const processingInstant = new Date(effectiveFrom.valueOf() + 30_000);
      const input = effectivityInput(versionId, processingInstant);
      const transitioned = await transitionDocumentVersionEffective(transaction(sql), input);
      expect(transitioned).toMatchObject({
        outcome: "TRANSITIONED",
        previousLifecycleState: "PUBLISHED",
        lifecycleState: "EFFECTIVE",
        effectiveFrom,
        documentActivated: true,
      });
      const state = await sql.query<{ lifecycle_status: string }>(
        "select lifecycle_status from document where tenant_id = $1 and id = $2",
        [TENANT, documentId],
      );
      expect(state.rows).toEqual([{ lifecycle_status: "ACTIVE" }]);
      const events = await sql.query<{
        event_type: string;
        actor_type: string;
        actor_id: string | null;
        occurred_at: Date;
      }>(
        `select event_type, actor_type, actor_id, occurred_at
           from audit_event where correlation_id = $1 order by sequence`,
        [input.correlationId],
      );
      expect(events.rows).toEqual([
        {
          event_type: "version.effective",
          actor_type: "SYSTEM",
          actor_id: null,
          occurred_at: effectiveFrom,
        },
        {
          event_type: "document.activated",
          actor_type: "SYSTEM",
          actor_id: null,
          occurred_at: effectiveFrom,
        },
      ]);

      const repeated = await transitionDocumentVersionEffective(transaction(sql), {
        ...input,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      expect(repeated).toMatchObject({
        outcome: "ALREADY_TRANSITIONED",
        emittedEvents: [],
      });
      const activationEvents = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'document.activated' and document_id = $1`,
        [documentId],
      );
      expect(activationEvents.rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-EFF-003: supersedes the authoritative predecessor exactly at the scheduled boundary", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const predecessorId = randomUUID();
      const successorId = randomUUID();
      await addVariant(sql, variantId);
      const predecessorRowVersion = await addApprovedVersion(sql, predecessorId, variantId, 1);
      const predecessorAt = new Date(Date.now() - 180_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(predecessorId, predecessorRowVersion, predecessorAt, predecessorAt),
      );
      const successorRowVersion = await addApprovedVersion(sql, successorId, variantId, 2);
      const publishedAt = new Date(Date.now() - 120_000);
      const effectiveFrom = new Date(Date.now() - 60_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(successorId, successorRowVersion, publishedAt, effectiveFrom),
      );

      const input = effectivityInput(successorId, effectiveFrom);
      const transitioned = await transitionDocumentVersionEffective(transaction(sql), input);
      expect(transitioned).toMatchObject({
        outcome: "TRANSITIONED",
        predecessorVersionId: predecessorId,
        documentActivated: false,
      });
      const states = await sql.query<{ id: string; lifecycle_state: string }>(
        `select id, lifecycle_state from document_version
          where id = any($1::uuid[]) order by version_sequence`,
        [[predecessorId, successorId]],
      );
      expect(states.rows).toEqual([
        { id: predecessorId, lifecycle_state: "SUPERSEDED" },
        { id: successorId, lifecycle_state: "EFFECTIVE" },
      ]);
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [input.correlationId],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        "version.superseded",
        "version.effective",
      ]);
    });
  });

  it("INV-EFF-007 / INV-EFF-008: treats not-due, cancelled and ineligible versions as explicit no-ops", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      await addVariant(sql, variantId);

      const notDueId = randomUUID();
      const notDueRowVersion = await addApprovedVersion(sql, notDueId, variantId, 1);
      const publishedAt = new Date(Date.now() - 60_000);
      const effectiveFrom = new Date(Date.now() + 60_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(notDueId, notDueRowVersion, publishedAt, effectiveFrom),
      );
      expect(
        await transitionDocumentVersionEffective(
          transaction(sql),
          effectivityInput(notDueId, publishedAt),
        ),
      ).toMatchObject({ outcome: "NOT_DUE", emittedEvents: [] });

      const cancelledId = randomUUID();
      await addApprovedVersion(sql, cancelledId, variantId, 2);
      await sql.query(
        `update document_version
            set lifecycle_state = 'CANCELLED', row_version = row_version + 1
          where tenant_id = $1 and id = $2`,
        [TENANT, cancelledId],
      );
      expect(
        await transitionDocumentVersionEffective(
          transaction(sql),
          effectivityInput(cancelledId, publishedAt),
        ),
      ).toMatchObject({ outcome: "CANCELLED", emittedEvents: [] });

      const approvedId = randomUUID();
      await addApprovedVersion(sql, approvedId, variantId, 3);
      expect(
        await transitionDocumentVersionEffective(
          transaction(sql),
          effectivityInput(approvedId, publishedAt),
        ),
      ).toMatchObject({ outcome: "INELIGIBLE", emittedEvents: [] });
    });
  });

  it("INV-EFF-004 / INV-EFF-008: a withdrawn scheduled version emits one high-severity gap and never resurrects a predecessor", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const predecessorId = randomUUID();
      const withdrawnId = randomUUID();
      await addVariant(sql, variantId);
      const predecessorRowVersion = await addApprovedVersion(sql, predecessorId, variantId, 1);
      const predecessorAt = new Date(Date.now() - 180_000);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(predecessorId, predecessorRowVersion, predecessorAt, predecessorAt),
      );
      const withdrawnRowVersion = await addApprovedVersion(sql, withdrawnId, variantId, 2);
      const publishedAt = new Date(Date.now() - 120_000);
      const effectiveFrom = new Date(Date.now() - 60_000);
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(withdrawnId, withdrawnRowVersion, publishedAt, effectiveFrom),
      );
      await withdrawDocumentVersion(transaction(sql), {
        ...publicationInput(withdrawnId, published.rowVersion, publishedAt, effectiveFrom),
        withdrawalReason: "Withdrawn before scheduled narration",
      });

      const input = effectivityInput(withdrawnId, effectiveFrom);
      const first = await transitionDocumentVersionEffective(transaction(sql), input);
      expect(first).toMatchObject({ outcome: "WITHDRAWN", policyGap: true });
      expect(first.emittedEvents).toHaveLength(1);
      const second = await transitionDocumentVersionEffective(transaction(sql), {
        ...input,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      expect(second).toMatchObject({ outcome: "WITHDRAWN", policyGap: false, emittedEvents: [] });

      const predecessor = await sql.query<{ lifecycle_state: string }>(
        "select lifecycle_state from document_version where tenant_id = $1 and id = $2",
        [TENANT, predecessorId],
      );
      expect(predecessor.rows).toEqual([{ lifecycle_state: "EFFECTIVE" }]);
      const gaps = await sql.query<{
        count: number;
        severity: string;
        actor_type: string;
      }>(
        `select count(*)::int as count,
                min(safe_after->>'severity') as severity,
                min(actor_type::text) as actor_type
           from audit_event
          where event_type = 'governance.policy_gap'
            and document_version_id = $1`,
        [withdrawnId],
      );
      expect(gaps.rows).toEqual([{ count: 1, severity: "HIGH", actor_type: "SYSTEM" }]);
    });
  });

  it("INV-EFF-005: emits no policy gap when a replacement already holds the withdrawn instant", async () => {
    await withTenant(TENANT, async (sql) => {
      const variantId = randomUUID();
      const withdrawnId = randomUUID();
      const replacementId = randomUUID();
      await addVariant(sql, variantId);
      const withdrawnRowVersion = await addApprovedVersion(sql, withdrawnId, variantId, 1);
      const publishedAt = new Date(Date.now() - 120_000);
      const effectiveFrom = new Date(Date.now() - 60_000);
      const published = await publishDocumentVersion(
        transaction(sql),
        publicationInput(withdrawnId, withdrawnRowVersion, publishedAt, effectiveFrom),
      );
      await withdrawDocumentVersion(transaction(sql), {
        ...publicationInput(withdrawnId, published.rowVersion, publishedAt, effectiveFrom),
        withdrawalReason: "Replace before scheduled narration",
      });
      const replacementRowVersion = await addApprovedVersion(sql, replacementId, variantId, 2);
      await publishDocumentVersion(
        transaction(sql),
        publicationInput(replacementId, replacementRowVersion, publishedAt, effectiveFrom),
      );

      const transition = await transitionDocumentVersionEffective(
        transaction(sql),
        effectivityInput(withdrawnId, effectiveFrom),
      );
      expect(transition).toMatchObject({
        outcome: "WITHDRAWN",
        policyGap: false,
        emittedEvents: [],
      });
      expect(
        await resolveEffectiveVersion(transaction(sql), {
          tenantId: TENANT,
          documentVariantId: variantId,
          at: effectiveFrom,
        }),
      ).toMatchObject({ id: replacementId });
      const gaps = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'governance.policy_gap' and document_version_id = $1`,
        [withdrawnId],
      );
      expect(gaps.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-TEN-001 / INV-TEN-003: the effective-instant entry point fails closed and hides cross-tenant identifiers", async () => {
    await withoutTenant(async (sql) => {
      await expect(
        transitionDocumentVersionEffective(
          transaction(sql),
          effectivityInput(randomUUID(), new Date(Date.now() - 1_000)),
        ),
      ).rejects.toThrow();
    });
    await withTenant(TENANT, async (sql) => {
      await expect(
        transitionDocumentVersionEffective(
          transaction(sql),
          effectivityInput(OTHER_VERSION, new Date(Date.now() - 1_000)),
        ),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundError);
    });
  });

  it("installs a narrow SECURITY DEFINER transition owned by migration_role", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        owner: string;
        prosecdef: boolean;
        proconfig: string[];
        acl: string;
      }>(`
        select pg_get_userbyid(proc.proowner) as owner,
               proc.prosecdef,
               proc.proconfig,
               proc.proacl::text as acl
          from pg_proc proc
          join pg_namespace namespace on namespace.oid = proc.pronamespace
         where namespace.nspname = 'public'
           and proc.proname = 'transition_document_version_effective'
      `),
    );
    expect(rows).toEqual([
      {
        owner: "migration_role",
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, public"],
        acl: "{migration_role=X/migration_role,app_role=X/migration_role}",
      },
    ]);
    const privileges = await withAppRole((sql) =>
      sql.query<{ grantee: string; privilege_type: string }>(`
        select grantee, privilege_type
          from information_schema.routine_privileges
         where routine_schema = 'public'
           and routine_name = 'transition_document_version_effective'
         order by grantee, privilege_type
      `),
    );
    expect(privileges.rows).toEqual([{ grantee: "app_role", privilege_type: "EXECUTE" }]);
  });
});

describe("effective-instant transaction concurrency", () => {
  async function concurrentTransition(
    input: TransitionDocumentVersionEffectiveInput,
  ): Promise<unknown> {
    return withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        const result = await transitionDocumentVersionEffective(transaction(sql), input);
        await sql.query("commit");
        return result;
      } catch (error) {
        await sql.query("rollback");
        return error;
      }
    });
  }

  it("INV-EFF-007 / INV-TIME-003: eight contenders emit exactly one effective event", async () => {
    const variantId = randomUUID();
    const versionId = randomUUID();
    const { effectiveFrom } = await addCommittedScheduledVersion(variantId, versionId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        concurrentTransition(effectivityInput(versionId, effectiveFrom)),
      ),
    );

    expect(results.filter((result) => result instanceof Error)).toEqual([]);
    expect(
      results.filter(
        (result) =>
          (result as Awaited<ReturnType<typeof transitionDocumentVersionEffective>>).outcome ===
          "TRANSITIONED",
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          (result as Awaited<ReturnType<typeof transitionDocumentVersionEffective>>).outcome ===
          "ALREADY_TRANSITIONED",
      ),
    ).toHaveLength(7);
    await committedTenant(TENANT, async (sql) => {
      const events = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'version.effective' and document_version_id = $1`,
        [versionId],
      );
      expect(events.rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-EFF-004 / INV-EFF-008: a transition blocked behind withdrawal re-reads WITHDRAWN and emits no effective event", async () => {
    const variantId = randomUUID();
    const versionId = randomUUID();
    const { effectiveFrom, rowVersion } = await addCommittedScheduledVersion(variantId, versionId);
    let releaseWithdrawal!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWithdrawal = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });

    const withdrawal = withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        await sql.query(
          "select 1 from document_variant where tenant_id = $1 and id = $2 for update",
          [TENANT, variantId],
        );
        reportLocked();
        await release;
        await withdrawDocumentVersion(transaction(sql), {
          tenantId: TENANT,
          versionId,
          expectedRowVersion: rowVersion,
          withdrawalReason: "Concurrent emergency withdrawal",
          actor: { type: "USER", id: USER },
          configurationVersionId: CONFIGURATION,
          occurredAt: new Date(),
          requestId: randomUUID(),
          correlationId: randomUUID(),
          sourceChannel: "API",
        });
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    });
    await locked;

    let transitionSettled = false;
    const transition = concurrentTransition(effectivityInput(versionId, effectiveFrom)).then(
      (result) => {
        transitionSettled = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transitionSettled).toBe(false);
    releaseWithdrawal();

    await withdrawal;
    const transitionResult = await transition;
    expect(transitionResult).toMatchObject({
      outcome: "WITHDRAWN",
      lifecycleState: "WITHDRAWN",
      policyGap: true,
    });
    await committedTenant(TENANT, async (sql) => {
      const state = await sql.query<{ lifecycle_state: string }>(
        "select lifecycle_state from document_version where tenant_id = $1 and id = $2",
        [TENANT, versionId],
      );
      expect(state.rows).toEqual([{ lifecycle_state: "WITHDRAWN" }]);
      const effectiveEvents = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'version.effective' and document_version_id = $1`,
        [versionId],
      );
      expect(effectiveEvents.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-EFF-003 / INV-AUD-004: rollback leaves scheduled lifecycle state and events unchanged", async () => {
    const variantId = randomUUID();
    const versionId = randomUUID();
    const { effectiveFrom } = await addCommittedScheduledVersion(variantId, versionId);
    await withTenant(TENANT, async (sql) => {
      await transitionDocumentVersionEffective(
        transaction(sql),
        effectivityInput(versionId, effectiveFrom),
      );
    });
    await committedTenant(TENANT, async (sql) => {
      const state = await sql.query<{ lifecycle_state: string }>(
        "select lifecycle_state from document_version where tenant_id = $1 and id = $2",
        [TENANT, versionId],
      );
      expect(state.rows).toEqual([{ lifecycle_state: "PUBLISHED" }]);
      const events = await sql.query<{ count: number }>(
        `select count(*)::int as count from audit_event
          where event_type = 'version.effective' and document_version_id = $1`,
        [versionId],
      );
      expect(events.rows).toEqual([{ count: 0 }]);
    });
  });
});
