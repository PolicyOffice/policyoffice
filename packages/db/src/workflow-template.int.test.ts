import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkflowConfigurationNotFoundError,
  WorkflowMandateUnsatisfiedError,
  assignWorkflowTemplateToDocumentType,
  publishWorkflowTemplateVersion,
  type AuditTransaction,
} from "../../domain/src/index.js";
import { withMigrationRole__PRIVILEGED, withTenant, type Sql } from "@policyoffice/testing";

const TENANT = "f1000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "f2000000-0000-0000-0000-000000000002";
const USER = "f1000000-0000-0000-0001-000000000001";
const OTHER_USER = "f2000000-0000-0000-0001-000000000002";
const INACTIVE_USER = "f1000000-0000-0000-0001-000000000003";
const ENTITY = "f1000000-0000-0000-0002-000000000001";
const OTHER_ENTITY = "f2000000-0000-0000-0002-000000000002";
const BODY = "f1000000-0000-0000-0003-000000000001";
const OTHER_BODY = "f2000000-0000-0000-0003-000000000002";
const OTHER_TEMPLATE = "f2000000-0000-0000-0004-000000000002";
const FIXED_INSTANT = new Date("2027-01-01T00:00:00.000Z");

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function participant(type: "USER" | "GOVERNANCE_BODY", id: string) {
  return { type, id } as const;
}

function mandate(type: "USER" | "GOVERNANCE_BODY", id: string) {
  const required = { requires: [participant(type, id)] };
  return {
    EDITORIAL: required,
    NON_MATERIAL: required,
    MATERIAL: required,
    EMERGENCY: required,
  };
}

function stages(type: "USER" | "GOVERNANCE_BODY", id: string) {
  return [
    {
      order: 1,
      name: type === "USER" ? "Named authority" : "Board resolution",
      completionRule: type === "USER" ? "ALL" : "BODY_RESOLUTION",
      participants: [participant(type, id)],
    },
  ];
}

async function insertTemplate(sql: Sql, id: string, label: string): Promise<void> {
  await sql.query(
    `insert into workflow_template (tenant_id, id, name, purpose, status)
     values ($1, $2, $3, 'Integration test', 'ACTIVE')`,
    [TENANT, id, label],
  );
}

async function insertDocumentType(
  sql: Sql,
  id: string,
  authority: unknown,
  templateId: string | null,
): Promise<void> {
  await sql.query(
    `insert into document_type (
       tenant_id, id, code, name, rank, mandated_authority,
       default_workflow_template_id, default_review_rule,
       requires_attestation_by_default, status
     ) values ($1, $2, $3, $3, 90, $4::jsonb, $5, '{}'::jsonb, false, 'ACTIVE')`,
    [TENANT, id, `TYPE_${id.slice(-4)}`, JSON.stringify(authority), templateId],
  );
}

async function clearTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await sql.query("delete from document_type where tenant_id = $1", [tenantId]);
    await sql.query(
      `update workflow_template
          set active_version_id = null, row_version = row_version + 1
        where tenant_id = $1 and active_version_id is not null`,
      [tenantId],
    );
    await sql.query("delete from workflow_template_version where tenant_id = $1", [tenantId]);
    await sql.query("delete from workflow_template where tenant_id = $1", [tenantId]);
    await sql.query("delete from governance_body where tenant_id = $1", [tenantId]);
    await sql.query("delete from legal_entity where tenant_id = $1", [tenantId]);
    await sql.query("delete from app_user where tenant_id = $1", [tenantId]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function seedTenant(
  sql: Sql,
  tenantId: string,
  userId: string,
  entityId: string,
  bodyId: string,
  label: string,
): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [tenantId, userId, `${label} user`, `${label.toLowerCase()}@workflow.test`],
    );
    await sql.query(
      `insert into legal_entity (tenant_id, id, legal_name, status)
       values ($1, $2, $3, 'ACTIVE')`,
      [tenantId, entityId, `${label} entity`],
    );
    await sql.query(
      `insert into governance_body (
         tenant_id, id, code, name, legal_entity_id, quorum_rule, status
       ) values ($1, $2, $3, $4, $5, '{}'::jsonb, 'ACTIVE')`,
      [tenantId, bodyId, `${label}_BOARD`, `${label} board`, entityId],
    );
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Workflow tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other workflow tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
    await seedTenant(sql, TENANT, USER, ENTITY, BODY, "Workflow");
    await seedTenant(sql, OTHER_TENANT, OTHER_USER, OTHER_ENTITY, OTHER_BODY, "Other");
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await sql.query(
        `insert into app_user (
           tenant_id, id, display_name, contact_email, status, deactivated_at
         ) values ($1, $2, 'Inactive workflow user', 'inactive@workflow.test',
                   'DEACTIVATED', $3)`,
        [TENANT, INACTIVE_USER, FIXED_INSTANT.toISOString()],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [OTHER_TENANT]);
      await sql.query(
        `insert into workflow_template (tenant_id, id, name, purpose, status)
         values ($1, $2, 'Other template', 'Cross-tenant fixture', 'ACTIVE')`,
        [OTHER_TENANT, OTHER_TEMPLATE],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
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

describe("workflow template publication and assignment", () => {
  it("INV-APR-020: publishes a version that binds every active type mandate", async () => {
    await withTenant(TENANT, async (sql) => {
      const templateId = "f1000000-0000-0000-0010-000000000001";
      const versionId = "f1000000-0000-0000-0011-000000000001";
      const typeId = "f1000000-0000-0000-0012-000000000001";
      await insertTemplate(sql, templateId, "Satisfying template");
      await insertDocumentType(sql, typeId, mandate("GOVERNANCE_BODY", BODY), templateId);

      const published = await publishWorkflowTemplateVersion(transaction(sql), {
        tenantId: TENANT,
        workflowTemplateId: templateId,
        workflowTemplateVersionId: versionId,
        versionSequence: 1,
        stages: stages("GOVERNANCE_BODY", BODY),
        separationOfDutiesRules: [],
        publishedAt: FIXED_INSTANT,
        publishedBy: USER,
      });

      expect(published).toMatchObject({
        id: versionId,
        workflowTemplateId: templateId,
        versionSequence: 1,
        publishedAt: FIXED_INSTANT,
        publishedBy: USER,
        templateRowVersion: 2,
      });
      const active = await sql.query<{ active_version_id: string }>(
        "select active_version_id from workflow_template where id = $1",
        [templateId],
      );
      expect(active.rows).toEqual([{ active_version_id: versionId }]);
    });
  });

  it("INV-APR-020: refuses publication with the unmet requirement and writes no version", async () => {
    await withTenant(TENANT, async (sql) => {
      const templateId = "f1000000-0000-0000-0020-000000000001";
      const versionId = "f1000000-0000-0000-0021-000000000001";
      const typeId = "f1000000-0000-0000-0022-000000000001";
      await insertTemplate(sql, templateId, "Unsatisfying template");
      await insertDocumentType(sql, typeId, mandate("GOVERNANCE_BODY", BODY), templateId);

      await expect(
        publishWorkflowTemplateVersion(transaction(sql), {
          tenantId: TENANT,
          workflowTemplateId: templateId,
          workflowTemplateVersionId: versionId,
          versionSequence: 1,
          stages: stages("USER", USER),
          separationOfDutiesRules: [],
          publishedAt: FIXED_INSTANT,
          publishedBy: USER,
        }),
      ).rejects.toMatchObject({
        documentTypeId: typeId,
        unmet: {
          materiality: "EDITORIAL",
          participant: participant("GOVERNANCE_BODY", BODY),
        },
      } satisfies Partial<WorkflowMandateUnsatisfiedError>);
      const stored = await sql.query<{ count: number }>(
        "select count(*)::int as count from workflow_template_version where id = $1",
        [versionId],
      );
      expect(stored.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-APR-020: refuses assigning an active version below the type mandate", async () => {
    await withTenant(TENANT, async (sql) => {
      const templateId = "f1000000-0000-0000-0030-000000000001";
      const versionId = "f1000000-0000-0000-0031-000000000001";
      const typeId = "f1000000-0000-0000-0032-000000000001";
      await insertTemplate(sql, templateId, "User-only template");
      await publishWorkflowTemplateVersion(transaction(sql), {
        tenantId: TENANT,
        workflowTemplateId: templateId,
        workflowTemplateVersionId: versionId,
        versionSequence: 1,
        stages: stages("USER", USER),
        separationOfDutiesRules: [],
        publishedAt: FIXED_INSTANT,
        publishedBy: USER,
      });
      await insertDocumentType(sql, typeId, mandate("GOVERNANCE_BODY", BODY), null);

      await expect(
        assignWorkflowTemplateToDocumentType(transaction(sql), {
          tenantId: TENANT,
          documentTypeId: typeId,
          workflowTemplateId: templateId,
          expectedRowVersion: 1,
          changedAt: FIXED_INSTANT,
        }),
      ).rejects.toBeInstanceOf(WorkflowMandateUnsatisfiedError);
      const stored = await sql.query<{ default_workflow_template_id: string | null }>(
        "select default_workflow_template_id from document_type where id = $1",
        [typeId],
      );
      expect(stored.rows).toEqual([{ default_workflow_template_id: null }]);
    });
  });

  it("INV-APR-010: app_role cannot update a published workflow template version", async () => {
    await withTenant(TENANT, async (sql) => {
      const templateId = "f1000000-0000-0000-0040-000000000001";
      const versionId = "f1000000-0000-0000-0041-000000000001";
      await insertTemplate(sql, templateId, "Immutable template");
      await publishWorkflowTemplateVersion(transaction(sql), {
        tenantId: TENANT,
        workflowTemplateId: templateId,
        workflowTemplateVersionId: versionId,
        versionSequence: 1,
        stages: stages("USER", USER),
        separationOfDutiesRules: [],
        publishedAt: FIXED_INSTANT,
        publishedBy: USER,
      });
      await expect(
        sql.query(
          `update workflow_template_version
              set stages = '[]'::jsonb, row_version = row_version + 1
            where id = $1`,
          [versionId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("INV-TEN-001 / INV-TEN-003: another tenant's template is indistinguishable from absent", async () => {
    await withTenant(TENANT, async (sql) => {
      const visible = await sql.query("select id from workflow_template where id = $1", [
        OTHER_TEMPLATE,
      ]);
      expect(visible.rows).toEqual([]);
      await expect(
        publishWorkflowTemplateVersion(transaction(sql), {
          tenantId: TENANT,
          workflowTemplateId: OTHER_TEMPLATE,
          workflowTemplateVersionId: "f1000000-0000-0000-0051-000000000001",
          versionSequence: 1,
          stages: stages("USER", USER),
          separationOfDutiesRules: [],
          publishedAt: FIXED_INSTANT,
          publishedBy: USER,
        }),
      ).rejects.toBeInstanceOf(WorkflowConfigurationNotFoundError);
    });
  });

  it("refuses a stored mandate naming an inactive participant", async () => {
    await withTenant(TENANT, async (sql) => {
      const templateId = "f1000000-0000-0000-0060-000000000001";
      const versionId = "f1000000-0000-0000-0061-000000000001";
      const typeId = "f1000000-0000-0000-0062-000000000001";
      await insertTemplate(sql, templateId, "Inactive mandate template");
      await insertDocumentType(sql, typeId, mandate("USER", INACTIVE_USER), templateId);
      await expect(
        publishWorkflowTemplateVersion(transaction(sql), {
          tenantId: TENANT,
          workflowTemplateId: templateId,
          workflowTemplateVersionId: versionId,
          versionSequence: 1,
          stages: stages("USER", USER),
          separationOfDutiesRules: [],
          publishedAt: FIXED_INSTANT,
          publishedBy: USER,
        }),
      ).rejects.toMatchObject({ code: "PARTICIPANT_NOT_ACTIVE" });
    });
  });
});
