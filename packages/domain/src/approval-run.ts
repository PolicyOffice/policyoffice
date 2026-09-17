import type {
  AuditActorType,
  AuditEventInput,
  AuditSourceChannel,
  AuditTransaction,
} from "./audit.js";
import type { Materiality } from "./version.js";
import {
  WorkflowConfigurationNotFoundError,
  WorkflowMandateUnsatisfiedError,
  WorkflowTemplateValidationError,
  findUnmetMandateRequirement,
  parseMandatedAuthority,
  parseWorkflowStages,
  type ActiveWorkflowParticipants,
  type WorkflowParticipantType,
  type WorkflowStage,
} from "./workflow-template.js";

export interface ApprovalRunConfigurationInput {
  readonly documentTypeId: string;
  readonly materiality: Materiality | null;
  readonly workflowTemplateId: string | null;
  readonly workflowTemplateVersionId: string | null;
  readonly stages: unknown;
  readonly mandatedAuthority: unknown;
}

export interface ApprovalRunPlan {
  readonly documentTypeId: string;
  readonly materiality: Materiality;
  readonly workflowTemplateId: string;
  readonly workflowTemplateVersionId: string;
  readonly stages: readonly WorkflowStage[];
}

export interface ResolvableApprovalParticipant {
  readonly type: Extract<WorkflowParticipantType, "USER" | "GOVERNANCE_BODY">;
  readonly id: string;
  readonly displayName: string;
}

export type ResolvedApprovalParticipant = ResolvableApprovalParticipant;

export interface ResolvedApprovalStage {
  readonly order: number;
  readonly participants: readonly ResolvedApprovalParticipant[];
}

export class ApprovalRunMaterialityRequiredError extends Error {
  constructor(readonly documentTypeId: string) {
    super(`document type ${documentTypeId} cannot start an approval run without materiality`);
    this.name = "ApprovalRunMaterialityRequiredError";
  }
}

export class ApprovalRunWorkflowRequiredError extends Error {
  constructor(readonly documentTypeId: string) {
    super(`document type ${documentTypeId} has no default workflow template`);
    this.name = "ApprovalRunWorkflowRequiredError";
  }
}

export class ApprovalRunActiveWorkflowVersionRequiredError extends Error {
  constructor(readonly workflowTemplateId: string) {
    super(`workflow template ${workflowTemplateId} has no active version`);
    this.name = "ApprovalRunActiveWorkflowVersionRequiredError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function participantKey(type: WorkflowParticipantType, id: string): string {
  return `${type}:${id.toLowerCase()}`;
}

function collectReferencedParticipantIds(values: readonly unknown[]): ActiveWorkflowParticipants {
  const userIds = new Set<string>();
  const governanceBodyIds = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id === "string" && UUID.test(candidate.id)) {
      if (candidate.type === "USER") userIds.add(candidate.id);
      if (candidate.type === "GOVERNANCE_BODY") governanceBodyIds.add(candidate.id);
    }
    for (const item of Object.values(candidate)) visit(item);
  };
  for (const value of values) visit(value);
  return { userIds, governanceBodyIds };
}

/**
 * Validate the workflow bound at submission and re-check the mandated-authority floor.
 * This is pure so fail-closed configuration refusals are testable without a database.
 */
export function planApprovalRun(input: ApprovalRunConfigurationInput): ApprovalRunPlan {
  if (input.workflowTemplateId === null) {
    throw new ApprovalRunWorkflowRequiredError(input.documentTypeId);
  }
  if (input.workflowTemplateVersionId === null) {
    throw new ApprovalRunActiveWorkflowVersionRequiredError(input.workflowTemplateId);
  }
  if (input.materiality === null) {
    throw new ApprovalRunMaterialityRequiredError(input.documentTypeId);
  }

  // Publication already validated these immutable values. At run start they are parsed again
  // before current participant availability is read, so the floor is checked before resolution.
  const referenced = collectReferencedParticipantIds([input.stages, input.mandatedAuthority]);
  const stages = parseWorkflowStages(input.stages, referenced);
  const mandate = parseMandatedAuthority(input.mandatedAuthority, referenced);
  const unmet = findUnmetMandateRequirement(stages, mandate, input.materiality);
  if (unmet) throw new WorkflowMandateUnsatisfiedError(input.documentTypeId, unmet);

  return Object.freeze({
    documentTypeId: input.documentTypeId,
    materiality: input.materiality,
    workflowTemplateId: input.workflowTemplateId,
    workflowTemplateVersionId: input.workflowTemplateVersionId,
    stages,
  });
}

/** Resolve the Pilot's identity participants once and freeze their human-readable names. */
export function resolveApprovalRunParticipants(
  plan: ApprovalRunPlan,
  participants: readonly ResolvableApprovalParticipant[],
): readonly ResolvedApprovalStage[] {
  const active = {
    userIds: new Set(participants.filter(({ type }) => type === "USER").map(({ id }) => id)),
    governanceBodyIds: new Set(
      participants.filter(({ type }) => type === "GOVERNANCE_BODY").map(({ id }) => id),
    ),
  };
  // Re-parse against participants that are active now. This preserves the established
  // PARTICIPANT_NOT_ACTIVE refusal and prevents an unavailable identity entering a run.
  const stages = parseWorkflowStages(plan.stages, active);
  const byIdentity = new Map(
    participants.map((participant) => [
      participantKey(participant.type, participant.id),
      participant,
    ]),
  );
  return Object.freeze(
    stages.map((stage) =>
      Object.freeze({
        order: stage.order,
        participants: Object.freeze(
          stage.participants.map((participant) => {
            const resolved = byIdentity.get(participantKey(participant.type, participant.id));
            if (!resolved) {
              throw new WorkflowTemplateValidationError(
                "PARTICIPANT_NOT_ACTIVE",
                `stages[${stage.order - 1}].participants`,
                `${participant.type}:${participant.id} does not name an active tenant participant`,
              );
            }
            return Object.freeze({
              type: resolved.type,
              id: participant.id,
              displayName: resolved.displayName,
            });
          }),
        ),
      }),
    ),
  );
}

interface DocumentTypeWorkflowRow extends Record<string, unknown> {
  default_workflow_template_id: string | null;
  mandated_authority: unknown;
}

interface WorkflowTemplateRow extends Record<string, unknown> {
  active_version_id: string | null;
}

interface WorkflowTemplateVersionRow extends Record<string, unknown> {
  stages: unknown;
}

interface ActiveParticipantRow extends Record<string, unknown> {
  participant_type: "USER" | "GOVERNANCE_BODY";
  id: string;
  display_name: string;
}

export interface PreparedApprovalRun {
  readonly plan: ApprovalRunPlan;
  readonly resolvedParticipants: readonly ResolvedApprovalStage[];
}

/** Internal submission collaborator; deliberately absent from the package's public index. */
export async function prepareApprovalRunForSubmission(
  transaction: AuditTransaction,
  input: Readonly<{
    tenantId: string;
    documentTypeId: string;
    materiality: Materiality | null;
  }>,
): Promise<PreparedApprovalRun> {
  const documentTypeResult = await transaction.query<DocumentTypeWorkflowRow>(
    `select default_workflow_template_id, mandated_authority
       from document_type
      where tenant_id = $1::uuid and id = $2::uuid
      for share`,
    [input.tenantId, input.documentTypeId],
  );
  const documentType = documentTypeResult.rows[0];
  if (!documentType) throw new WorkflowConfigurationNotFoundError();
  if (documentType.default_workflow_template_id === null) {
    planApprovalRun({
      documentTypeId: input.documentTypeId,
      materiality: input.materiality,
      workflowTemplateId: null,
      workflowTemplateVersionId: null,
      stages: null,
      mandatedAuthority: documentType.mandated_authority,
    });
  }
  const workflowTemplateId = documentType.default_workflow_template_id;
  if (workflowTemplateId === null) throw new ApprovalRunWorkflowRequiredError(input.documentTypeId);

  const templateResult = await transaction.query<WorkflowTemplateRow>(
    `select active_version_id
       from workflow_template
      where tenant_id = $1::uuid and id = $2::uuid
      for share`,
    [input.tenantId, workflowTemplateId],
  );
  const template = templateResult.rows[0];
  if (!template) throw new WorkflowConfigurationNotFoundError();
  if (template.active_version_id === null) {
    planApprovalRun({
      documentTypeId: input.documentTypeId,
      materiality: input.materiality,
      workflowTemplateId,
      workflowTemplateVersionId: null,
      stages: null,
      mandatedAuthority: documentType.mandated_authority,
    });
  }
  const workflowTemplateVersionId = template.active_version_id;
  if (workflowTemplateVersionId === null) {
    throw new ApprovalRunActiveWorkflowVersionRequiredError(workflowTemplateId);
  }

  const versionResult = await transaction.query<WorkflowTemplateVersionRow>(
    `select stages
       from workflow_template_version
      where tenant_id = $1::uuid
        and id = $2::uuid
        and workflow_template_id = $3::uuid`,
    [input.tenantId, workflowTemplateVersionId, workflowTemplateId],
  );
  const workflowVersion = versionResult.rows[0];
  if (!workflowVersion) throw new WorkflowConfigurationNotFoundError();

  const plan = planApprovalRun({
    documentTypeId: input.documentTypeId,
    materiality: input.materiality,
    workflowTemplateId,
    workflowTemplateVersionId,
    stages: workflowVersion.stages,
    mandatedAuthority: documentType.mandated_authority,
  });

  const userIds = plan.stages
    .flatMap(({ participants }) => participants)
    .filter(({ type }) => type === "USER")
    .map(({ id }) => id);
  const bodyIds = plan.stages
    .flatMap(({ participants }) => participants)
    .filter(({ type }) => type === "GOVERNANCE_BODY")
    .map(({ id }) => id);
  const users = await transaction.query<ActiveParticipantRow>(
    `select 'USER'::text as participant_type, id, display_name
       from app_user
      where tenant_id = $2::uuid and status = 'ACTIVE' and id = any($1::uuid[])
      for share`,
    [userIds, input.tenantId],
  );
  const bodies = await transaction.query<ActiveParticipantRow>(
    `select 'GOVERNANCE_BODY'::text as participant_type, id, name as display_name
       from governance_body
      where tenant_id = $2::uuid and status = 'ACTIVE' and id = any($1::uuid[])
      for share`,
    [bodyIds, input.tenantId],
  );
  const participants = [...users.rows, ...bodies.rows].map((row) => ({
    type: row.participant_type,
    id: row.id,
    displayName: row.display_name,
  }));
  return Object.freeze({
    plan,
    resolvedParticipants: resolveApprovalRunParticipants(plan, participants),
  });
}

interface CreatedRunRow extends Record<string, unknown> {
  id: string;
}

interface CreatedStageRow extends Record<string, unknown> {
  id: string;
}

interface CreatedTaskRow extends Record<string, unknown> {
  id: string;
}

interface ApprovalRunAuditContext {
  readonly actor: Readonly<{ type: AuditActorType; id: string | null }>;
  readonly configurationVersionId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sourceChannel: AuditSourceChannel;
}

/** Internal write path invoked only by submitContentRevision. */
export async function createApprovalRunForSubmission(
  transaction: AuditTransaction,
  input: ApprovalRunAuditContext &
    Readonly<{
      tenantId: string;
      documentId: string;
      documentVariantId: string;
      documentVersionId: string;
      contentRevisionId: string;
      prepared: PreparedApprovalRun;
    }>,
): Promise<readonly AuditEventInput[]> {
  const runResult = await transaction.query<CreatedRunRow>(
    `insert into approval_run (
       tenant_id, content_revision_id, workflow_template_version_id,
       resolved_participants, status, started_at, configuration_version_id
     ) values ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, 'RUNNING', $5::timestamptz, $6::uuid)
     returning id`,
    [
      input.tenantId,
      input.contentRevisionId,
      input.prepared.plan.workflowTemplateVersionId,
      JSON.stringify(input.prepared.resolvedParticipants),
      input.occurredAt.toISOString(),
      input.configurationVersionId,
    ],
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("approval run insert returned no row");

  const events: AuditEventInput[] = [
    {
      tenantId: input.tenantId,
      eventType: "approval_run.started",
      eventSchemaVersion: 1,
      occurredAt: input.occurredAt,
      actor: input.actor,
      subject: { type: "APPROVAL_RUN", id: run.id },
      documentId: input.documentId,
      documentVariantId: input.documentVariantId,
      documentVersionId: input.documentVersionId,
      action: "START_APPROVAL_RUN",
      outcome: "SUCCESS",
      requestId: input.requestId,
      correlationId: input.correlationId,
      sourceChannel: input.sourceChannel,
      safeBefore: null,
      safeAfter: {
        workflowTemplateVersionId: input.prepared.plan.workflowTemplateVersionId,
        status: "RUNNING",
      },
      configurationVersionId: input.configurationVersionId,
      dedupeKey: `approval_run.started:${run.id}`,
    },
  ];

  for (const stage of input.prepared.plan.stages) {
    const stageResult = await transaction.query<CreatedStageRow>(
      `insert into approval_stage (
         tenant_id, approval_run_id, stage_order, completion_rule, threshold,
         status, due_at, completed_at
       ) values (
         $1::uuid, $2::uuid, $3::integer, $4::completion_rule, $5::integer,
         $6::approval_stage_status, null, null
       )
       returning id`,
      [
        input.tenantId,
        run.id,
        stage.order,
        stage.completionRule,
        stage.threshold ?? null,
        stage.order === 1 ? "IN_PROGRESS" : "PENDING",
      ],
    );
    const createdStage = stageResult.rows[0];
    if (!createdStage) throw new Error("approval stage insert returned no row");
    if (stage.order !== 1) continue;

    events.push({
      tenantId: input.tenantId,
      eventType: "approval_stage.started",
      eventSchemaVersion: 1,
      occurredAt: input.occurredAt,
      actor: input.actor,
      subject: { type: "APPROVAL_STAGE", id: createdStage.id },
      documentId: input.documentId,
      documentVariantId: input.documentVariantId,
      documentVersionId: input.documentVersionId,
      action: "START_APPROVAL_STAGE",
      outcome: "SUCCESS",
      requestId: input.requestId,
      correlationId: input.correlationId,
      sourceChannel: input.sourceChannel,
      safeBefore: null,
      safeAfter: { approvalRunId: run.id, stageOrder: stage.order, status: "IN_PROGRESS" },
      configurationVersionId: input.configurationVersionId,
      dedupeKey: `approval_stage.started:${createdStage.id}`,
    });

    for (const participant of stage.participants) {
      const taskResult = await transaction.query<CreatedTaskRow>(
        `insert into approval_task (
           tenant_id, approval_stage_id, participant_type, participant_id,
           status, assigned_at, due_at, delegated_from_user_id
         ) values (
           $1::uuid, $2::uuid, $3::approval_participant_type, $4::uuid,
           'PENDING', $5::timestamptz, null, null
         )
         returning id`,
        [
          input.tenantId,
          createdStage.id,
          participant.type,
          participant.id,
          input.occurredAt.toISOString(),
        ],
      );
      const task = taskResult.rows[0];
      if (!task) throw new Error("approval task insert returned no row");
      events.push({
        tenantId: input.tenantId,
        eventType: "approval_task.assigned",
        eventSchemaVersion: 1,
        occurredAt: input.occurredAt,
        actor: input.actor,
        subject: { type: "APPROVAL_TASK", id: task.id },
        documentId: input.documentId,
        documentVariantId: input.documentVariantId,
        documentVersionId: input.documentVersionId,
        action: "ASSIGN_APPROVAL_TASK",
        outcome: "SUCCESS",
        requestId: input.requestId,
        correlationId: input.correlationId,
        sourceChannel: input.sourceChannel,
        safeBefore: null,
        safeAfter: {
          approvalStageId: createdStage.id,
          participantType: participant.type,
          participantId: participant.id,
          status: "PENDING",
        },
        configurationVersionId: input.configurationVersionId,
        dedupeKey: `approval_task.assigned:${task.id}`,
      });
    }
  }

  return Object.freeze(events);
}
