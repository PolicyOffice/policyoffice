import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalBodyResolutionEvidenceError,
  ApprovalBodyResolutionRequiredError,
  ApprovalBodyResolutionUnauthorizedError,
  ApprovalRunNotRunningError,
  ApprovalStageNotInProgressError,
  ApprovalTaskNotHeldError,
  ApprovalTaskNotPendingError,
  AuthzContext,
  createContentRevision,
  recordApprovalDecision,
  recordBodyResolution,
  submitContentRevision,
  type ApprovalDecisionKind,
  type AuditTransaction,
  type RecordBodyResolutionInput,
} from "../../domain/src/index.js";
import { withAppRole, withTenant, type Sql } from "@policyoffice/testing";
import { authorizationDataLoader } from "./authorization.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
const tenant = required(fixture.tenants[0], "approval tests require the first fixture tenant");
const otherTenant = required(
  fixture.tenants[1],
  "approval tests require the second fixture tenant",
);
const document = required(tenant.documents[0], "approval fixture requires a document");
const decidingUser = required(
  tenant.users.find(({ id }) => id === tenant.workflowTemplate.publishedBy),
  "approval fixture requires its workflow participant",
);

const TENANT = tenant.tenant.id;
const OTHER_TENANT = otherTenant.tenant.id;
const USER = decidingUser.id;
const CONFIGURATION = tenant.configuration.id;
const ONE_STAGE_RUN = "a1000000-0000-0000-0000-000000000001";
const ONE_STAGE_STAGE = "a1000000-0000-0000-0000-000000000002";
const ONE_STAGE_TASK = "a1000000-0000-0000-0000-000000000003";
const SECOND_USER = "a1000000-0000-0000-0000-000000000004";
const PENDING_STAGE_TASK = "a1000000-0000-0000-0000-000000000005";
const NEXT_REVISION = "a1000000-0000-0000-0000-000000000006";
const COMMITTED_VARIANT = "a1000000-0000-0000-0000-000000000007";
const COMMITTED_VERSION = "a1000000-0000-0000-0000-000000000008";
const COMMITTED_REVISION = "a1000000-0000-0000-0000-000000000009";
const TWO_STAGE_SECOND_STAGE = "a1000000-0000-0000-0000-00000000000a";
const BODY_GRANT = "a1000000-0000-0000-0000-00000000000b";
const OTHER_BODY = "a1000000-0000-0000-0000-00000000000c";
const OTHER_BODY_GRANT = "a1000000-0000-0000-0000-00000000000d";
const DOCUMENT_APPROVE_GRANT = "a1000000-0000-0000-0000-00000000000e";
const REQUEST = "a2000000-0000-0000-0000-000000000001";
const CORRELATION = "a2000000-0000-0000-0000-000000000002";
const DECIDED_AT = new Date("2026-09-19T10:00:00.000Z");
const SUBMITTED_AT = new Date("2026-09-17T10:00:00.000Z");

function transaction(sql: Sql): AuditTransaction {
  return {
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      const result = await sql.query<Row>(text, values);
      return { rows: result.rows };
    },
  };
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function databaseConstraint(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "constraint" in error
    ? String(error.constraint)
    : undefined;
}

async function atSavepoint(
  sql: Sql,
  name: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  await sql.query(`savepoint ${name}`);
  try {
    await operation();
  } finally {
    await sql.query(`rollback to savepoint ${name}`);
    await sql.query(`release savepoint ${name}`);
  }
}

async function setupOneStageRun(
  sql: Sql,
  includeBodyStage = false,
  submittedAt = DECIDED_AT,
): Promise<void> {
  await sql.query(
    `update content_revision
        set submitted_at = $2::timestamptz, row_version = row_version + 1
      where id = $1 and submitted_at is null`,
    [document.contentRevisionId, submittedAt.toISOString()],
  );
  await sql.query(
    `update document_version
        set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
      where id = $1 and lifecycle_state = 'DRAFT'`,
    [document.draftVersionId],
  );
  const resolved = [
    {
      order: 1,
      participants: [{ type: "USER", id: USER, displayName: decidingUser.displayName }],
    },
    ...(includeBodyStage
      ? [
          {
            order: 2,
            participants: [
              {
                type: "GOVERNANCE_BODY",
                id: tenant.governanceBody.id,
                displayName: tenant.governanceBody.name,
              },
            ],
          },
        ]
      : []),
  ];
  await sql.query(
    `insert into approval_run (
       tenant_id, id, content_revision_id, workflow_template_version_id,
       resolved_participants, status, started_at, configuration_version_id
     ) values ($1, $2, $3, $4, $5::jsonb, 'RUNNING', $6, $7)`,
    [
      TENANT,
      ONE_STAGE_RUN,
      document.contentRevisionId,
      tenant.workflowTemplate.versionId,
      JSON.stringify(resolved),
      DECIDED_AT.toISOString(),
      CONFIGURATION,
    ],
  );
  await sql.query(
    `insert into approval_stage (
       tenant_id, id, approval_run_id, stage_order, completion_rule, threshold, status
     ) values ($1, $2, $3, 1, 'ALL', null, 'IN_PROGRESS')`,
    [TENANT, ONE_STAGE_STAGE, ONE_STAGE_RUN],
  );
  if (includeBodyStage) {
    await sql.query(
      `insert into approval_stage (
         tenant_id, id, approval_run_id, stage_order, completion_rule, threshold, status
       ) values ($1, $2, $3, 2, 'BODY_RESOLUTION', null, 'PENDING')`,
      [TENANT, TWO_STAGE_SECOND_STAGE, ONE_STAGE_RUN],
    );
  }
  await sql.query(
    `insert into approval_task (
       tenant_id, id, approval_stage_id, participant_type, participant_id, status, assigned_at
     ) values ($1, $2, $3, 'USER', $4, 'PENDING', $5)`,
    [TENANT, ONE_STAGE_TASK, ONE_STAGE_STAGE, USER, DECIDED_AT.toISOString()],
  );
}

async function setupCommittedOneStageRun(sql: Sql): Promise<void> {
  const classification = tenant.classifications[0];
  if (!classification) throw new Error("approval fixture requires a classification");
  await sql.query(
    `insert into document_variant (
       tenant_id, id, document_id, variant_type, source_variant_id, status
     ) values ($1, $2, $3, 'SUPPLEMENT', $4, 'ACTIVE')`,
    [TENANT, COMMITTED_VARIANT, document.id, document.baselineVariantId],
  );
  await sql.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id, materiality,
       change_summary, configuration_version_id
     ) values ($1, $2, $3, 1, 'race', 'DRAFT', $4, 'Concurrent approval fixture',
               $5, 'MATERIAL', 'Concurrent approval fixture', $6)`,
    [
      TENANT,
      COMMITTED_VERSION,
      COMMITTED_VARIANT,
      document.documentTypeId,
      classification.id,
      CONFIGURATION,
    ],
  );
  const digest = `sha-256:${"a".repeat(64)}`;
  await sql.query(
    `insert into content_revision (
       tenant_id, id, document_version_id, revision_sequence, content_ref,
       canonical_manifest, canonicalisation_schema_version, content_digest,
       created_by, submitted_at
     ) values ($1, $2, $3, 1, null, $4::jsonb, 1, $5, $6, $7)`,
    [
      TENANT,
      COMMITTED_REVISION,
      COMMITTED_VERSION,
      JSON.stringify("concurrent approval fixture"),
      digest,
      USER,
      DECIDED_AT.toISOString(),
    ],
  );
  await sql.query(
    `update document_version
        set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
      where id = $1`,
    [COMMITTED_VERSION],
  );
  const resolved = [
    {
      order: 1,
      participants: [{ type: "USER", id: USER, displayName: decidingUser.displayName }],
    },
  ];
  await sql.query(
    `insert into approval_run (
       tenant_id, id, content_revision_id, workflow_template_version_id,
       resolved_participants, status, started_at, configuration_version_id
     ) values ($1, $2, $3, $4, $5::jsonb, 'RUNNING', $6, $7)`,
    [
      TENANT,
      ONE_STAGE_RUN,
      COMMITTED_REVISION,
      tenant.workflowTemplate.versionId,
      JSON.stringify(resolved),
      DECIDED_AT.toISOString(),
      CONFIGURATION,
    ],
  );
  await sql.query(
    `insert into approval_stage (
       tenant_id, id, approval_run_id, stage_order, completion_rule, threshold, status
     ) values ($1, $2, $3, 1, 'ALL', null, 'IN_PROGRESS')`,
    [TENANT, ONE_STAGE_STAGE, ONE_STAGE_RUN],
  );
  await sql.query(
    `insert into approval_task (
       tenant_id, id, approval_stage_id, participant_type, participant_id, status, assigned_at
     ) values ($1, $2, $3, 'USER', $4, 'PENDING', $5)`,
    [TENANT, ONE_STAGE_TASK, ONE_STAGE_STAGE, USER, DECIDED_AT.toISOString()],
  );
}

function decide(
  sql: Sql,
  approvalTaskId: string,
  decision: ApprovalDecisionKind,
  decidingUserId = USER,
  correlationId = CORRELATION,
) {
  return recordApprovalDecision(transaction(sql), {
    tenantId: TENANT,
    approvalTaskId,
    decidingUserId,
    decision,
    actor: { type: "USER", id: decidingUserId },
    configurationVersionId: CONFIGURATION,
    occurredAt: DECIDED_AT,
    requestId: REQUEST,
    correlationId,
    sourceChannel: "API",
  });
}

function authorizationContext(sql: Sql, principalId = USER): AuthzContext {
  return new AuthzContext({
    tenantId: TENANT,
    principal: { type: "USER", id: principalId },
    instant: DECIDED_AT,
    load: authorizationDataLoader(transaction(sql)),
  });
}

async function insertDirectGrant(
  sql: Sql,
  input: Readonly<{
    id: string;
    capability: "body.act_for" | "document.approve";
    scopeType: "GOVERNANCE_BODY" | "DOCUMENT_VERSION";
    scopeId: string;
  }>,
): Promise<void> {
  await sql.query(
    `insert into access_grant (
       tenant_id, id, effect, principal_type, principal_id,
       security_role_id, capability, scope_type, scope_id,
       validity, granted_by, reason
     ) values (
       $1, $2, 'ALLOW', 'USER', $3,
       null, $4::capability, $5::scope_type, $6,
       tstzrange('2026-01-01T00:00:00Z', null, '[)'), $3, null
     )`,
    [TENANT, input.id, USER, input.capability, input.scopeType, input.scopeId],
  );
}

function resolveBody(
  sql: Sql,
  approvalTaskId: string,
  overrides: Partial<RecordBodyResolutionInput> = {},
) {
  return recordBodyResolution(transaction(sql), authorizationContext(sql), {
    tenantId: TENANT,
    approvalTaskId,
    recordedByUserId: USER,
    decision: "APPROVE",
    resolutionReference: "MB-2026-09-18-01",
    resolutionDate: "2026-09-18",
    minutesAttachmentId: document.contentAttachmentId,
    attendingMembers: [USER],
    configurationVersionId: CONFIGURATION,
    occurredAt: DECIDED_AT,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API",
    ...overrides,
  });
}

async function committedTenant(operation: (sql: Sql) => Promise<void>): Promise<void> {
  await withAppRole(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await operation(sql);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

beforeEach(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("approval decisions", () => {
  it("INV-APR-001 / INV-APR-008: the final ALL approval records exact evidence and approves once", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      const result = await decide(sql, ONE_STAGE_TASK, "APPROVE");
      expect(result).toMatchObject({
        approvalRunId: ONE_STAGE_RUN,
        contentRevisionId: document.contentRevisionId,
        decision: "APPROVE",
        runStatus: "COMPLETED",
        versionLifecycleState: "APPROVED",
      });

      const decision = await sql.query<{
        approval_task_id: string;
        decided_by_type: string;
        decided_by_id: string;
        recorded_by_user_id: string;
        content_revision_id: string;
        content_digest: string;
        configuration_version_id: string;
      }>("select * from approval_decision where approval_task_id = $1", [ONE_STAGE_TASK]);
      expect(decision.rows[0]).toMatchObject({
        approval_task_id: ONE_STAGE_TASK,
        decided_by_type: "USER",
        decided_by_id: USER,
        recorded_by_user_id: USER,
        content_revision_id: document.contentRevisionId,
        configuration_version_id: CONFIGURATION,
      });
      expect(decision.rows[0]?.content_digest).toMatch(/^sha-256:[0-9a-f]{64}$/);

      const state = await sql.query<{
        run_status: string;
        stage_status: string;
        task_status: string;
        lifecycle_state: string;
      }>(
        `select run.status as run_status, stage.status as stage_status,
                task.status as task_status, version.lifecycle_state
           from approval_run run
           join approval_stage stage on stage.approval_run_id = run.id
           join approval_task task on task.approval_stage_id = stage.id
           join content_revision revision on revision.id = run.content_revision_id
           join document_version version on version.id = revision.document_version_id
          where run.id = $1`,
        [ONE_STAGE_RUN],
      );
      expect(state.rows).toEqual([
        {
          run_status: "COMPLETED",
          stage_status: "COMPLETED",
          task_status: "DECIDED",
          lifecycle_state: "APPROVED",
        },
      ]);
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [CORRELATION],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        "approval.approved",
        "approval_stage.completed",
        "approval_run.completed",
        "version.approved",
      ]);
    });
  });

  it("INV-APR-008 / INV-APR-012: stage two starts from the frozen resolution", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql, true);
      await sql.query(
        `update governance_body
            set name = 'Renamed after submission', status = 'DISSOLVED', closed_at = $2,
                row_version = row_version + 1
          where id = $1`,
        [tenant.governanceBody.id, DECIDED_AT.toISOString()],
      );
      const result = await decide(sql, ONE_STAGE_TASK, "APPROVE");
      expect(result.runStatus).toBe("RUNNING");
      expect(result.versionLifecycleState).toBe("IN_REVIEW");

      const stages = await sql.query<{ stage_order: number; status: string }>(
        `select stage_order, status from approval_stage
          where approval_run_id = $1 order by stage_order`,
        [ONE_STAGE_RUN],
      );
      expect(stages.rows).toEqual([
        { stage_order: 1, status: "COMPLETED" },
        { stage_order: 2, status: "IN_PROGRESS" },
      ]);
      const bodyTask = await sql.query<{
        id: string;
        participant_type: string;
        participant_id: string;
        status: string;
      }>(
        "select id, participant_type, participant_id, status from approval_task where approval_stage_id = $1",
        [TWO_STAGE_SECOND_STAGE],
      );
      expect(bodyTask.rows).toHaveLength(1);
      expect(bodyTask.rows[0]).toMatchObject({
        participant_type: "GOVERNANCE_BODY",
        participant_id: tenant.governanceBody.id,
        status: "PENDING",
      });
      await expect(decide(sql, bodyTask.rows[0]?.id ?? "", "APPROVE")).rejects.toBeInstanceOf(
        ApprovalBodyResolutionRequiredError,
      );
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [CORRELATION],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        "approval.approved",
        "approval_stage.completed",
        "approval_stage.started",
        "approval_task.assigned",
      ]);
    });
  });

  it("INV-APR-021 / INV-APR-022 / INV-APR-023: ALL then BODY_RESOLUTION approves as the institution", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql, true, SUBMITTED_AT);
      await insertDirectGrant(sql, {
        id: BODY_GRANT,
        capability: "body.act_for",
        scopeType: "GOVERNANCE_BODY",
        scopeId: tenant.governanceBody.id,
      });
      await decide(sql, ONE_STAGE_TASK, "APPROVE");
      const bodyTask = await sql.query<{ id: string }>(
        "select id from approval_task where approval_stage_id = $1",
        [TWO_STAGE_SECOND_STAGE],
      );
      const result = await resolveBody(sql, required(bodyTask.rows[0]?.id, "body task missing"));
      expect(result).toMatchObject({
        runStatus: "COMPLETED",
        versionLifecycleState: "APPROVED",
      });

      const stored = await sql.query<{
        decided_by_type: string;
        decided_by_id: string;
        recorded_by_user_id: string;
        resolution_reference: string;
        resolution_date: string;
        minutes_attachment_id: string;
        attending_members: string[];
        configuration_version_id: string;
      }>(
        `select decided_by_type, decided_by_id, recorded_by_user_id,
                resolution_reference, resolution_date::text as resolution_date,
                minutes_attachment_id, attending_members, configuration_version_id
           from approval_decision where id = $1`,
        [result.id],
      );
      expect(stored.rows[0]).toMatchObject({
        decided_by_type: "BODY",
        decided_by_id: tenant.governanceBody.id,
        recorded_by_user_id: USER,
        resolution_reference: "MB-2026-09-18-01",
        resolution_date: "2026-09-18",
        minutes_attachment_id: document.contentAttachmentId,
        attending_members: [USER],
        configuration_version_id: CONFIGURATION,
      });

      const states = await sql.query<{
        run_status: string;
        stage_statuses: string[];
        lifecycle_state: string;
      }>(
        `select run.status as run_status,
                array_agg(stage.status::text order by stage.stage_order) as stage_statuses,
                version.lifecycle_state
           from approval_run run
           join approval_stage stage on stage.approval_run_id = run.id
           join content_revision revision on revision.id = run.content_revision_id
           join document_version version on version.id = revision.document_version_id
          where run.id = $1
          group by run.status, version.lifecycle_state`,
        [ONE_STAGE_RUN],
      );
      expect(states.rows).toEqual([
        {
          run_status: "COMPLETED",
          stage_statuses: ["COMPLETED", "COMPLETED"],
          lifecycle_state: "APPROVED",
        },
      ]);

      const events = await sql.query<{
        event_type: string;
        actor_type: string;
        actor_id: string;
        safe_after: Record<string, unknown>;
      }>(
        `select event_type, actor_type, actor_id, safe_after
           from audit_event where correlation_id = $1 order by sequence`,
        [CORRELATION],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        "approval.approved",
        "approval_stage.completed",
        "approval_stage.started",
        "approval_task.assigned",
        "approval.approved",
        "approval_stage.completed",
        "approval_run.completed",
        "version.approved",
      ]);
      const bodyEvents = events.rows.slice(4);
      expect(bodyEvents.every(({ actor_type }) => actor_type === "BODY")).toBe(true);
      expect(bodyEvents.every(({ actor_id }) => actor_id === tenant.governanceBody.id)).toBe(true);
      expect(bodyEvents[0]?.safe_after).toMatchObject({
        decidedByType: "BODY",
        decidedById: tenant.governanceBody.id,
      });
      expect(bodyEvents[0]?.safe_after).not.toHaveProperty("recordedByUserId");

      await atSavepoint(sql, "duplicate_body_decision", async () => {
        try {
          await sql.query(
            `insert into approval_decision (
               tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
               recorded_by_user_id, content_revision_id, content_digest,
               configuration_version_id
             )
             select tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
                    recorded_by_user_id, content_revision_id, content_digest,
                    configuration_version_id
               from approval_decision where id = $1`,
            [result.id],
          );
          expect.unreachable("the database accepted a second body decision for one task");
        } catch (error) {
          expect(databaseCode(error)).toBe("23505");
          expect(databaseConstraint(error)).toBe("approval_decision_task_unique");
        }
      });

      const beforeDissolution = await sql.query<{ bytes: string }>(
        "select encode(convert_to(to_jsonb(approval_decision)::text, 'UTF8'), 'hex') as bytes from approval_decision where id = $1",
        [result.id],
      );
      await sql.query(
        `update governance_body
            set status = 'DISSOLVED', closed_at = $2, row_version = row_version + 1
          where id = $1`,
        [tenant.governanceBody.id, DECIDED_AT.toISOString()],
      );
      expect(
        await sql.query<{ bytes: string }>(
          "select encode(convert_to(to_jsonb(approval_decision)::text, 'UTF8'), 'hex') as bytes from approval_decision where id = $1",
          [result.id],
        ),
      ).toEqual(beforeDissolution);
    });
  });

  it.each([
    ["REQUEST_CHANGES", "CHANGES_REQUESTED", ["approval.changes_requested"]],
    ["REJECT", "REJECTED", ["approval.rejected", "version.rejected"]],
  ] as const)(
    "body %s has the same terminal run and version outcome as a user decision",
    async (decision, expectedStatus, expectedEvents) => {
      await withTenant(TENANT, async (sql) => {
        await insertDirectGrant(sql, {
          id: BODY_GRANT,
          capability: "body.act_for",
          scopeType: "GOVERNANCE_BODY",
          scopeId: tenant.governanceBody.id,
        });
        const result = await resolveBody(sql, document.approvalBodyTaskId, { decision });
        expect(result.runStatus).toBe(expectedStatus);
        expect(result.versionLifecycleState).toBe(expectedStatus);
        const events = await sql.query<{ event_type: string }>(
          "select event_type from audit_event where correlation_id = $1 order by sequence",
          [CORRELATION],
        );
        expect(events.rows.map(({ event_type }) => event_type)).toEqual(expectedEvents);
      });
    },
  );

  it("INV-APR-023: a grant for another body is refused without a decision", async () => {
    await withTenant(TENANT, async (sql) => {
      await sql.query(
        `insert into governance_body (
           tenant_id, id, code, name, legal_entity_id, quorum_rule, status
         ) values ($1, $2, 'OTHER_BOARD', 'Other Board', $3, '{}'::jsonb, 'ACTIVE')`,
        [TENANT, OTHER_BODY, tenant.legalEntity.id],
      );
      await insertDirectGrant(sql, {
        id: OTHER_BODY_GRANT,
        capability: "body.act_for",
        scopeType: "GOVERNANCE_BODY",
        scopeId: OTHER_BODY,
      });
      await expect(resolveBody(sql, document.approvalBodyTaskId)).rejects.toBeInstanceOf(
        ApprovalBodyResolutionUnauthorizedError,
      );
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            document.approvalBodyTaskId,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("INV-APR-023: document.approve never substitutes for body.act_for", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertDirectGrant(sql, {
        id: DOCUMENT_APPROVE_GRANT,
        capability: "document.approve",
        scopeType: "DOCUMENT_VERSION",
        scopeId: document.approvalVersionId,
      });
      await expect(resolveBody(sql, document.approvalBodyTaskId)).rejects.toBeInstanceOf(
        ApprovalBodyResolutionUnauthorizedError,
      );
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            document.approvalBodyTaskId,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("INV-APR-022: the date boundary is stable across session timezones", async () => {
    await withTenant(TENANT, async (sql) => {
      await insertDirectGrant(sql, {
        id: BODY_GRANT,
        capability: "body.act_for",
        scopeType: "GOVERNANCE_BODY",
        scopeId: tenant.governanceBody.id,
      });
      for (const [savepoint, timeZone] of [
        ["resolution_before_submission_utc", "UTC"],
        ["resolution_before_submission_los_angeles", "America/Los_Angeles"],
      ] as const) {
        await atSavepoint(sql, savepoint, async () => {
          await sql.query("select set_config('TimeZone', $1, true)", [timeZone]);
          try {
            await resolveBody(sql, document.approvalBodyTaskId, {
              resolutionDate: "2025-12-31",
              attendingMembers: null,
            });
            expect.unreachable("the database accepted a pre-submission resolution date");
          } catch (error) {
            expect(databaseCode(error)).toBe("23514");
            expect(databaseConstraint(error)).toBe(
              "approval_decision_resolution_date_not_before_submission",
            );
          }
        });
      }
      await expect(
        resolveBody(sql, document.approvalBodyTaskId, {
          resolutionDate: "2026-01-02",
          attendingMembers: [USER],
        }),
      ).resolves.toMatchObject({ runStatus: "COMPLETED" });
    });
  });

  it("INV-APR-021 / INV-TEN-003: the database rejects an absent or cross-tenant deciding body", async () => {
    await withTenant(TENANT, async (sql) => {
      await atSavepoint(sql, "foreign_deciding_body", async () => {
        try {
          await sql.query(
            `insert into approval_decision (
               tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
               recorded_by_user_id, content_revision_id, content_digest,
               configuration_version_id
             )
             select tenant_id, $2, 'APPROVE', 'BODY', $3, $4,
                    content_revision_id, content_digest, configuration_version_id
               from approval_decision where id = $5 and tenant_id = $1`,
            [
              TENANT,
              document.approvalBodyTaskId,
              otherTenant.governanceBody.id,
              USER,
              document.approvalDecisionId,
            ],
          );
          expect.unreachable("the database accepted a cross-tenant deciding body");
        } catch (error) {
          expect(databaseCode(error)).toBe("23503");
          expect(databaseConstraint(error)).toBe("approval_decision_deciding_body_fk");
        }
      });
    });
  });

  it("INV-ORG-002: an attendee without a dated seat is refused without a decision", async () => {
    await withTenant(TENANT, async (sql) => {
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Non-member attendee', 'non-member@example.test', 'ACTIVE')`,
        [TENANT, SECOND_USER],
      );
      await insertDirectGrant(sql, {
        id: BODY_GRANT,
        capability: "body.act_for",
        scopeType: "GOVERNANCE_BODY",
        scopeId: tenant.governanceBody.id,
      });
      await expect(
        resolveBody(sql, document.approvalBodyTaskId, { attendingMembers: [SECOND_USER] }),
      ).rejects.toBeInstanceOf(ApprovalBodyResolutionEvidenceError);
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            document.approvalBodyTaskId,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("INV-APR-003 / INV-APR-004: changes terminate the snapshot and resubmission creates a fresh run", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      const first = await decide(sql, ONE_STAGE_TASK, "REQUEST_CHANGES");
      expect(first).toMatchObject({
        runStatus: "CHANGES_REQUESTED",
        versionLifecycleState: "CHANGES_REQUESTED",
      });
      const decisionBefore = await sql.query("select * from approval_decision where id = $1", [
        first.id,
      ]);
      const revisionBefore = await sql.query("select * from content_revision where id = $1", [
        document.contentRevisionId,
      ]);

      const created = await createContentRevision(transaction(sql), {
        tenantId: TENANT,
        revisionId: NEXT_REVISION,
        documentVersionId: document.draftVersionId,
        createdByUserId: USER,
        contentBytes: new TextEncoder().encode("A corrected policy revision."),
        actor: { type: "USER", id: USER },
        configurationVersionId: CONFIGURATION,
        occurredAt: new Date("2026-09-19T11:00:00.000Z"),
        requestId: "a2000000-0000-0000-0000-000000000003",
        correlationId: "a2000000-0000-0000-0000-000000000004",
        sourceChannel: "API",
      });
      await submitContentRevision(transaction(sql), {
        tenantId: TENANT,
        documentVersionId: document.draftVersionId,
        revisionId: NEXT_REVISION,
        expectedVersionRowVersion: created.versionRowVersion,
        expectedRevisionRowVersion: created.rowVersion,
        actor: { type: "USER", id: USER },
        configurationVersionId: CONFIGURATION,
        occurredAt: new Date("2026-09-19T12:00:00.000Z"),
        requestId: "a2000000-0000-0000-0000-000000000005",
        correlationId: "a2000000-0000-0000-0000-000000000006",
        sourceChannel: "API",
      });

      const runs = await sql.query<{ id: string; content_revision_id: string; status: string }>(
        `select id, content_revision_id, status from approval_run
          where content_revision_id in ($1, $2) order by started_at`,
        [document.contentRevisionId, NEXT_REVISION],
      );
      expect(runs.rows).toHaveLength(2);
      expect(runs.rows[0]).toMatchObject({
        id: ONE_STAGE_RUN,
        content_revision_id: document.contentRevisionId,
        status: "CHANGES_REQUESTED",
      });
      expect(runs.rows[1]).toMatchObject({ content_revision_id: NEXT_REVISION, status: "RUNNING" });
      expect(await sql.query("select * from approval_decision where id = $1", [first.id])).toEqual(
        decisionBefore,
      );
      expect(
        await sql.query("select * from content_revision where id = $1", [
          document.contentRevisionId,
        ]),
      ).toEqual(revisionBefore);
      const decisionEvents = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [CORRELATION],
      );
      expect(decisionEvents.rows).toEqual([{ event_type: "approval.changes_requested" }]);
    });
  });

  it("approval rejection terminates the run and version with ordered evidence", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      const result = await decide(sql, ONE_STAGE_TASK, "REJECT");
      expect(result).toMatchObject({ runStatus: "REJECTED", versionLifecycleState: "REJECTED" });
      const events = await sql.query<{ event_type: string }>(
        "select event_type from audit_event where correlation_id = $1 order by sequence",
        [CORRELATION],
      );
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        "approval.rejected",
        "version.rejected",
      ]);
    });
  });

  it("a principal who does not hold the task is refused without a write", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Other approver', 'other.approver@example.test', 'ACTIVE')`,
        [TENANT, SECOND_USER],
      );
      await expect(decide(sql, ONE_STAGE_TASK, "APPROVE", SECOND_USER)).rejects.toBeInstanceOf(
        ApprovalTaskNotHeldError,
      );
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            ONE_STAGE_TASK,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("a task on a pending stage is refused without a write", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql, true);
      await sql.query(
        `insert into approval_task (
           tenant_id, id, approval_stage_id, participant_type, participant_id, status, assigned_at
         ) values ($1, $2, $3, 'USER', $4, 'PENDING', $5)`,
        [TENANT, PENDING_STAGE_TASK, TWO_STAGE_SECOND_STAGE, USER, DECIDED_AT.toISOString()],
      );
      await expect(decide(sql, PENDING_STAGE_TASK, "APPROVE")).rejects.toBeInstanceOf(
        ApprovalStageNotInProgressError,
      );
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            PENDING_STAGE_TASK,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("a task on a non-running run is refused without a write", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      await sql.query(
        `update approval_run set status = 'BLOCKED', row_version = row_version + 1 where id = $1`,
        [ONE_STAGE_RUN],
      );
      await expect(decide(sql, ONE_STAGE_TASK, "APPROVE")).rejects.toBeInstanceOf(
        ApprovalRunNotRunningError,
      );
      expect(
        (
          await sql.query("select id from approval_decision where approval_task_id = $1", [
            ONE_STAGE_TASK,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it("approval decisions are immutable and INV-APR-009 refuses a second task decision", async () => {
    await withTenant(TENANT, async (sql) => {
      await setupOneStageRun(sql);
      const result = await decide(sql, ONE_STAGE_TASK, "APPROVE");
      for (const [name, statement] of [
        ["update_decision", "update approval_decision set reason_code = 'changed' where id = $1"],
        ["delete_decision", "delete from approval_decision where id = $1"],
      ] as const) {
        await atSavepoint(sql, name, async () => {
          try {
            await sql.query(statement, [result.id]);
            expect.unreachable("app_role unexpectedly mutated an approval decision");
          } catch (error) {
            expect(databaseCode(error)).toBe("42501");
          }
        });
      }

      const stored = await sql.query<{
        content_revision_id: string;
        content_digest: string;
      }>("select content_revision_id, content_digest from approval_decision where id = $1", [
        result.id,
      ]);
      await atSavepoint(sql, "duplicate_decision", async () => {
        try {
          await sql.query(
            `insert into approval_decision (
               tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
               recorded_by_user_id, content_revision_id, content_digest, configuration_version_id
             ) values ($1, $2, 'APPROVE', 'USER', $3, $3, $4, $5, $6)`,
            [
              TENANT,
              ONE_STAGE_TASK,
              USER,
              stored.rows[0]?.content_revision_id,
              stored.rows[0]?.content_digest,
              CONFIGURATION,
            ],
          );
          expect.unreachable("the database accepted a second decision for one task");
        } catch (error) {
          expect(databaseCode(error)).toBe("23505");
          expect(databaseConstraint(error)).toBe("approval_decision_task_unique");
        }
      });
    });
  });

  it("INV-APR-012: the started run snapshot is immutable while status transitions remain writable", async () => {
    await withTenant(TENANT, async (sql) => {
      for (const [name, assignment] of [
        ["resolved", "resolved_participants = '[]'::jsonb"],
        ["workflow", "workflow_template_version_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'"],
        ["revision", "content_revision_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'"],
        ["started", "started_at = started_at + interval '1 second'"],
        ["configuration", "configuration_version_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'"],
      ] as const) {
        await atSavepoint(sql, `snapshot_${name}`, async () => {
          try {
            await sql.query(
              `update approval_run set ${assignment}, row_version = row_version + 1 where id = $1`,
              [document.approvalRunId],
            );
            expect.unreachable(`approval run accepted snapshot mutation ${name}`);
          } catch (error) {
            expect(databaseCode(error)).toBe("23514");
            expect(databaseConstraint(error)).toBe("approval_run_snapshot_immutable");
          }
        });
      }
      await sql.query(
        `update approval_run set status = 'BLOCKED', row_version = row_version + 1 where id = $1`,
        [document.approvalRunId],
      );
      expect(
        (
          await sql.query<{ status: string }>("select status from approval_run where id = $1", [
            document.approvalRunId,
          ])
        ).rows,
      ).toEqual([{ status: "BLOCKED" }]);
    });
  });

  it("INV-APR-009: two real transactions complete the last task exactly once", async () => {
    await committedTenant(setupCommittedOneStageRun);
    await withAppRole(async (firstSql) => {
      await withAppRole(async (secondSql) => {
        await firstSql.query("begin");
        await secondSql.query("begin");
        try {
          await firstSql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
          await secondSql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
          const winner = await decide(
            firstSql,
            ONE_STAGE_TASK,
            "APPROVE",
            USER,
            "a2000000-0000-0000-0000-000000000007",
          );
          const loser = decide(
            secondSql,
            ONE_STAGE_TASK,
            "APPROVE",
            USER,
            "a2000000-0000-0000-0000-000000000008",
          );
          await firstSql.query("commit");
          await expect(loser).rejects.toBeInstanceOf(ApprovalTaskNotPendingError);
          await secondSql.query("rollback");
          expect(winner.runStatus).toBe("COMPLETED");
        } catch (error) {
          await firstSql.query("rollback").catch(() => undefined);
          await secondSql.query("rollback").catch(() => undefined);
          throw error;
        }
      });
    });

    await withTenant(TENANT, async (sql) => {
      const events = await sql.query<{ event_type: string; count: number }>(
        `select event_type, count(*)::int as count
           from audit_event
          where event_type in ('approval_run.completed', 'version.approved')
          group by event_type order by event_type`,
      );
      expect(events.rows).toEqual([
        { event_type: "approval_run.completed", count: 1 },
        { event_type: "version.approved", count: 1 },
      ]);
    });
  });

  it("INV-TEN-001 / INV-TEN-003: another tenant cannot observe an approval decision", async () => {
    let decisionId = "";
    await committedTenant(async (sql) => {
      await setupCommittedOneStageRun(sql);
      decisionId = (await decide(sql, ONE_STAGE_TASK, "APPROVE")).id;
    });
    await withTenant(OTHER_TENANT, async (sql) => {
      expect(
        (await sql.query("select id from approval_decision where id = $1", [decisionId])).rows,
      ).toEqual([]);
    });
  });

  it("INV-TEN-001 / INV-TEN-003: another tenant cannot observe a body resolution", async () => {
    let decisionId = "";
    await committedTenant(async (sql) => {
      await insertDirectGrant(sql, {
        id: BODY_GRANT,
        capability: "body.act_for",
        scopeType: "GOVERNANCE_BODY",
        scopeId: tenant.governanceBody.id,
      });
      decisionId = (await resolveBody(sql, document.approvalBodyTaskId)).id;
    });
    await withTenant(OTHER_TENANT, async (sql) => {
      expect(
        (await sql.query("select id from approval_decision where id = $1", [decisionId])).rows,
      ).toEqual([]);
    });
  });
});
