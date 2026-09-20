import {
  buildFixtureSet,
  loadFixtureSet,
  removeFixtureSetForTests,
} from "../packages/db/src/fixtures.ts";
import { withTenantTransaction } from "../packages/db/src/application-transaction.ts";

const BROWSER_AUTHOR_ID = "c6000000-0000-0000-0001-000000000001";
const APPROVAL_VARIANT_ID = "c6000000-0000-0000-0040-000000000001";
const APPROVAL_VERSION_ID = "c6000000-0000-0000-0041-000000000001";
const APPROVAL_REVISION_ID = "c6000000-0000-0000-0042-000000000001";
const APPROVAL_RUN_ID = "c6000000-0000-0000-0043-000000000001";
const APPROVAL_STAGE_ID = "c6000000-0000-0000-0044-000000000001";
const APPROVAL_APPLICABILITY_RULE_ID = "c6000000-0000-0000-0047-000000000001";
export const APPROVAL_TASK_ID = "c6000000-0000-0000-0045-000000000001";
export const APPROVAL_DIGEST = `sha-256:${"b".repeat(64)}`;

export default async function globalSetup(): Promise<() => Promise<void>> {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  const tenant = buildFixtureSet("test").tenants[0];
  const userId = tenant?.users[0]?.id;
  const authorRoleId = tenant?.securityRoles.find((role) => role.code === "AUTHOR")?.id;
  const approverRoleId = tenant?.securityRoles.find((role) => role.code === "APPROVER")?.id;
  const document = tenant?.documents[0];
  const classificationId = tenant?.classifications[0]?.id;
  if (!tenant || !userId || !authorRoleId || !approverRoleId || !document || !classificationId) {
    throw new Error(
      "the browser fixture requires a tenant administrator, author/approver roles and document",
    );
  }
  await withTenantTransaction(
    { tenantId: tenant.tenant.id, principal: { type: "USER", id: userId } },
    async (transaction) => {
      await transaction.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, security_role_id,
           scope_type, scope_id, validity, granted_by, reason
         ) values (
           $1, 'a0000000-0000-0000-0025-000000000002', 'ALLOW', 'USER', $2,
           $3, 'TENANT', null, tstzrange($4::timestamptz, null, '[)'),
           $2, 'POL-033 browser author fixture'
         )`,
        [tenant.tenant.id, userId, authorRoleId, buildFixtureSet("test").createdAt],
      );
      await transaction.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, security_role_id,
           scope_type, scope_id, validity, granted_by, reason
         ) values (
           $1, 'a0000000-0000-0000-0025-000000000003', 'ALLOW', 'USER', $2,
           $3, 'TENANT', null, tstzrange($4::timestamptz, null, '[)'),
           $2, 'POL-034 browser approver fixture'
         )`,
        [tenant.tenant.id, userId, approverRoleId, buildFixtureSet("test").createdAt],
      );
      await transaction.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Browser Candidate Author', 'browser-candidate-author@example.test', 'ACTIVE')`,
        [tenant.tenant.id, BROWSER_AUTHOR_ID],
      );
      await transaction.query(
        `insert into document_variant (
           tenant_id, id, document_id, variant_type, source_variant_id, locale, status
         ) values ($1, $2, $3, 'SUPPLEMENT', $4, null, 'ACTIVE')`,
        [tenant.tenant.id, APPROVAL_VARIANT_ID, document.id, document.baselineVariantId],
      );
      await transaction.query(
        `insert into document_version (
           tenant_id, id, document_variant_id, version_sequence, display_label,
           lifecycle_state, document_type_id, title, classification_id, materiality,
           change_summary, configuration_version_id
         ) values (
           $1, $2, $3, 1, 'browser-approval-1', 'DRAFT', $4,
           'Browser Approval Candidate', $5, 'MATERIAL',
           'Browser candidate submitted by a distinct author', $6
         )`,
        [
          tenant.tenant.id,
          APPROVAL_VERSION_ID,
          APPROVAL_VARIANT_ID,
          document.documentTypeId,
          classificationId,
          tenant.configuration.id,
        ],
      );
      await transaction.query(
        `insert into content_revision (
           tenant_id, id, document_version_id, revision_sequence, content_ref,
           canonical_manifest, canonicalisation_schema_version, content_digest,
           created_by, submitted_at
         ) values ($1, $2, $3, 1, null, $4::jsonb, 1, $5, $6, $7)`,
        [
          tenant.tenant.id,
          APPROVAL_REVISION_ID,
          APPROVAL_VERSION_ID,
          JSON.stringify("browser-approval-candidate"),
          APPROVAL_DIGEST,
          BROWSER_AUTHOR_ID,
          "2026-01-01T00:05:00.000Z",
        ],
      );
      await transaction.query(
        `insert into applicability_rule (
           tenant_id, id, document_variant_id, authorised_by_version_id, effect,
           legal_entity_ids, org_unit_ids, jurisdiction_ids, group_ids, user_ids,
           inheritance_mode, validity
         ) values (
           $1, $2, $3, $4, 'INCLUDE', '{}'::uuid[], $5::uuid[], '{}'::uuid[],
           '{}'::uuid[], '{}'::uuid[], 'MANDATORY', tstzrange($6::timestamptz, null, '[)')
         )`,
        [
          tenant.tenant.id,
          APPROVAL_APPLICABILITY_RULE_ID,
          APPROVAL_VARIANT_ID,
          APPROVAL_VERSION_ID,
          [tenant.orgUnit.id],
          buildFixtureSet("test").createdAt,
        ],
      );
      await transaction.query(
        `update document_version
            set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
          where tenant_id = $1 and id = $2 and lifecycle_state = 'DRAFT'`,
        [tenant.tenant.id, APPROVAL_VERSION_ID],
      );
      await transaction.query(
        `insert into approval_run (
           tenant_id, id, content_revision_id, workflow_template_version_id,
           resolved_participants, status, started_at, configuration_version_id
         ) values ($1, $2, $3, $4, $5::jsonb, 'RUNNING', $6, $7)`,
        [
          tenant.tenant.id,
          APPROVAL_RUN_ID,
          APPROVAL_REVISION_ID,
          tenant.workflowTemplate.versionId,
          JSON.stringify([
            {
              order: 1,
              participants: [
                {
                  type: "USER",
                  id: userId,
                  displayName: tenant.users[0]?.displayName ?? "Test approver",
                },
              ],
            },
          ]),
          "2026-01-01T00:05:00.000Z",
          tenant.configuration.id,
        ],
      );
      await transaction.query(
        `insert into approval_stage (
           tenant_id, id, approval_run_id, stage_order, completion_rule, status
         ) values ($1, $2, $3, 1, 'ALL', 'IN_PROGRESS')`,
        [tenant.tenant.id, APPROVAL_STAGE_ID, APPROVAL_RUN_ID],
      );
      await transaction.query(
        `insert into approval_task (
           tenant_id, id, approval_stage_id, participant_type, participant_id,
           status, assigned_at
         ) values ($1, $2, $3, 'USER', $4, 'PENDING', $5)`,
        [tenant.tenant.id, APPROVAL_TASK_ID, APPROVAL_STAGE_ID, userId, "2026-01-01T00:05:00.000Z"],
      );
    },
  );
  return async () => removeFixtureSetForTests("test");
}
