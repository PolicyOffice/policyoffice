import {
  emitAuditEvents,
  type AuditActorType,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";

export const APPROVAL_DECISION_REQUIRED_CAPABILITIES = Object.freeze({
  record: "document.approve",
} as const);

export type ApprovalDecisionKind = "APPROVE" | "REQUEST_CHANGES" | "REJECT";
export type ApprovalCompletionRule = "ALL" | "ANY_ONE" | "AT_LEAST_N" | "BODY_RESOLUTION";

interface ApprovalDecisionAuditContext {
  readonly actor: Readonly<{ type: AuditActorType; id: string | null }>;
  readonly configurationVersionId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sourceChannel: AuditSourceChannel;
}

export interface RecordApprovalDecisionInput extends ApprovalDecisionAuditContext {
  readonly tenantId: string;
  readonly approvalTaskId: string;
  readonly decidingUserId: string;
  readonly decision: ApprovalDecisionKind;
  readonly reasonCode?: string | null;
  readonly commentRef?: string | null;
}

export interface RecordedApprovalDecision {
  readonly id: string;
  readonly approvalTaskId: string;
  readonly approvalRunId: string;
  readonly approvalStageId: string;
  readonly documentVersionId: string;
  readonly contentRevisionId: string;
  readonly contentDigest: string;
  readonly decision: ApprovalDecisionKind;
  readonly recordedAt: Date;
  readonly runStatus: "RUNNING" | "COMPLETED" | "CHANGES_REQUESTED" | "REJECTED";
  readonly versionLifecycleState: "IN_REVIEW" | "APPROVED" | "CHANGES_REQUESTED" | "REJECTED";
  readonly emittedEvents: readonly EmittedAuditEvent[];
}

export class ApprovalTaskNotFoundError extends Error {
  constructor() {
    super("approval task was not found");
    this.name = "ApprovalTaskNotFoundError";
  }
}

export class ApprovalTaskNotHeldError extends Error {
  constructor() {
    super("the deciding principal does not hold this approval task");
    this.name = "ApprovalTaskNotHeldError";
  }
}

export class ApprovalTaskNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`approval task is not pending (${status})`);
    this.name = "ApprovalTaskNotPendingError";
  }
}

export class ApprovalStageNotInProgressError extends Error {
  constructor(readonly status: string) {
    super(`approval stage is not in progress (${status})`);
    this.name = "ApprovalStageNotInProgressError";
  }
}

export class ApprovalRunNotRunningError extends Error {
  constructor(readonly status: string) {
    super(`approval run is not running (${status})`);
    this.name = "ApprovalRunNotRunningError";
  }
}

export class ApprovalVersionNotInReviewError extends Error {
  constructor(readonly status: string) {
    super(`document version is not in review (${status})`);
    this.name = "ApprovalVersionNotInReviewError";
  }
}

export class ApprovalBodyResolutionRequiredError extends Error {
  constructor() {
    super("BODY_RESOLUTION decisions must be recorded through POL-041's body-resolution command");
    this.name = "ApprovalBodyResolutionRequiredError";
  }
}

export class UnsupportedApprovalCompletionRuleError extends Error {
  constructor(readonly completionRule: ApprovalCompletionRule) {
    super(`${completionRule} is outside the Pilot approval-decision scope`);
    this.name = "UnsupportedApprovalCompletionRuleError";
  }
}

export class InvalidApprovalRunSnapshotError extends Error {
  constructor() {
    super("approval run contains an invalid frozen participant snapshot");
    this.name = "InvalidApprovalRunSnapshotError";
  }
}

interface LockedApprovalTaskRow extends Record<string, unknown> {
  task_id: string;
  task_status: "PENDING" | "DECIDED" | "REASSIGNED" | "UNRESOLVABLE" | "CANCELLED";
  participant_type: "USER" | "GOVERNANCE_BODY" | "ROLE_AT_SCOPE" | "GROUP";
  participant_id: string;
  stage_id: string;
  stage_order: number;
  stage_status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" | "CANCELLED";
  completion_rule: ApprovalCompletionRule;
  threshold: number | null;
  run_id: string;
  run_status: "RUNNING" | "BLOCKED" | "COMPLETED" | "CHANGES_REQUESTED" | "REJECTED" | "CANCELLED";
  resolved_participants: unknown;
  content_revision_id: string;
  content_digest: string;
  document_version_id: string;
  lifecycle_state: string;
  document_variant_id: string;
  document_id: string;
}

interface CreatedDecisionRow extends Record<string, unknown> {
  id: string;
  recorded_at: Date;
}

interface NextStageRow extends Record<string, unknown> {
  id: string;
  stage_order: number;
  status: string;
}

interface FrozenParticipant {
  readonly type: "USER" | "GOVERNANCE_BODY";
  readonly id: string;
  readonly displayName: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = new Set<ApprovalDecisionKind>(["APPROVE", "REQUEST_CHANGES", "REJECT"]);
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function validateInput(input: RecordApprovalDecisionInput): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.approvalTaskId, "approvalTaskId");
  requireUuid(input.decidingUserId, "decidingUserId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!DECISIONS.has(input.decision)) throw new TypeError("decision is not supported");
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  if (input.actor.type !== "USER" || input.actor.id !== input.decidingUserId) {
    throw new ApprovalTaskNotHeldError();
  }
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.valueOf())) {
    throw new TypeError("occurredAt must be a valid Date");
  }
  if (input.commentRef !== undefined && input.commentRef !== null) {
    requireUuid(input.commentRef, "commentRef");
  }
}

/** Evaluate only completion rules intentionally supported by the Pilot decision command. */
export function isApprovalStageSatisfied(
  input: Readonly<{
    completionRule: ApprovalCompletionRule;
    taskCount: number;
    approvalCount: number;
  }>,
): boolean {
  if (!Number.isInteger(input.taskCount) || input.taskCount < 1) {
    throw new TypeError("taskCount must be a positive integer");
  }
  if (
    !Number.isInteger(input.approvalCount) ||
    input.approvalCount < 0 ||
    input.approvalCount > input.taskCount
  ) {
    throw new TypeError("approvalCount must be an integer between zero and taskCount");
  }
  if (input.completionRule === "BODY_RESOLUTION") {
    throw new ApprovalBodyResolutionRequiredError();
  }
  if (input.completionRule !== "ALL") {
    throw new UnsupportedApprovalCompletionRuleError(input.completionRule);
  }
  return input.approvalCount === input.taskCount;
}

function frozenParticipantsForStage(
  snapshot: unknown,
  stageOrder: number,
): readonly FrozenParticipant[] {
  if (!Array.isArray(snapshot)) throw new InvalidApprovalRunSnapshotError();
  const stage = snapshot.find(
    (candidate): candidate is { order: number; participants: unknown } =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as { order?: unknown }).order === stageOrder &&
      Object.hasOwn(candidate, "participants"),
  );
  if (!stage || !Array.isArray(stage.participants) || stage.participants.length === 0) {
    throw new InvalidApprovalRunSnapshotError();
  }
  return Object.freeze(
    stage.participants.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new InvalidApprovalRunSnapshotError();
      }
      const participant = candidate as Record<string, unknown>;
      if (
        !["USER", "GOVERNANCE_BODY"].includes(String(participant.type)) ||
        typeof participant.id !== "string" ||
        !UUID.test(participant.id) ||
        typeof participant.displayName !== "string" ||
        participant.displayName.trim().length === 0
      ) {
        throw new InvalidApprovalRunSnapshotError();
      }
      return Object.freeze({
        type: participant.type as FrozenParticipant["type"],
        id: participant.id,
        displayName: participant.displayName,
      });
    }),
  );
}

async function lockApprovalTask(
  transaction: AuditTransaction,
  tenantId: string,
  approvalTaskId: string,
): Promise<LockedApprovalTaskRow> {
  const result = await transaction.query<LockedApprovalTaskRow>(
    `select task.id as task_id,
            task.status as task_status,
            task.participant_type,
            task.participant_id,
            stage.id as stage_id,
            stage.stage_order,
            stage.status as stage_status,
            stage.completion_rule,
            stage.threshold,
            run.id as run_id,
            run.status as run_status,
            run.resolved_participants,
            run.content_revision_id,
            revision.content_digest,
            version.id as document_version_id,
            version.lifecycle_state,
            variant.id as document_variant_id,
            variant.document_id
       from approval_task task
       join approval_stage stage
         on stage.tenant_id = task.tenant_id and stage.id = task.approval_stage_id
       join approval_run run
         on run.tenant_id = stage.tenant_id and run.id = stage.approval_run_id
       join content_revision revision
         on revision.tenant_id = run.tenant_id and revision.id = run.content_revision_id
       join document_version version
         on version.tenant_id = revision.tenant_id
        and version.id = revision.document_version_id
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where task.tenant_id = $1::uuid and task.id = $2::uuid
      for update of task, stage, run, version`,
    [tenantId, approvalTaskId],
  );
  const row = result.rows[0];
  if (!row) throw new ApprovalTaskNotFoundError();
  return row;
}

function assertActionable(row: LockedApprovalTaskRow, decidingUserId: string): void {
  if (row.task_status !== "PENDING") throw new ApprovalTaskNotPendingError(row.task_status);
  if (row.stage_status !== "IN_PROGRESS") {
    throw new ApprovalStageNotInProgressError(row.stage_status);
  }
  if (row.run_status !== "RUNNING") throw new ApprovalRunNotRunningError(row.run_status);
  if (row.lifecycle_state !== "IN_REVIEW") {
    throw new ApprovalVersionNotInReviewError(row.lifecycle_state);
  }
  if (row.completion_rule === "BODY_RESOLUTION") throw new ApprovalBodyResolutionRequiredError();
  if (row.participant_type !== "USER" || row.participant_id !== decidingUserId) {
    throw new ApprovalTaskNotHeldError();
  }
}

function decisionEvent(
  input: RecordApprovalDecisionInput,
  row: LockedApprovalTaskRow,
  decisionId: string,
): AuditEventInput {
  const eventType = {
    APPROVE: "approval.approved",
    REQUEST_CHANGES: "approval.changes_requested",
    REJECT: "approval.rejected",
  } as const;
  return {
    tenantId: input.tenantId,
    eventType: eventType[input.decision],
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "APPROVAL_DECISION", id: decisionId },
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    documentVersionId: row.document_version_id,
    action: input.decision,
    outcome: "SUCCESS",
    reasonCode: input.reasonCode ?? null,
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: null,
    safeAfter: {
      approvalTaskId: row.task_id,
      decidedByType: "USER",
      decidedById: input.decidingUserId,
      contentRevisionId: row.content_revision_id,
      contentDigest: row.content_digest,
      decision: input.decision,
    },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `${eventType[input.decision]}:${decisionId}`,
  };
}

function transitionEvent(
  input: RecordApprovalDecisionInput,
  row: LockedApprovalTaskRow,
  event: Readonly<{
    type:
      | "approval_stage.completed"
      | "approval_run.completed"
      | "version.approved"
      | "version.rejected";
    subjectType: "APPROVAL_STAGE" | "APPROVAL_RUN" | "DOCUMENT_VERSION";
    subjectId: string;
    action: string;
    from: string;
    to: string;
  }>,
): AuditEventInput {
  return {
    tenantId: input.tenantId,
    eventType: event.type,
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: event.subjectType, id: event.subjectId },
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    documentVersionId: row.document_version_id,
    action: event.action,
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore:
      event.subjectType === "DOCUMENT_VERSION"
        ? { lifecycleState: event.from }
        : { status: event.from },
    safeAfter:
      event.subjectType === "DOCUMENT_VERSION"
        ? { lifecycleState: event.to }
        : { status: event.to },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `${event.type}:${event.subjectId}`,
  };
}

async function startNextStage(
  transaction: AuditTransaction,
  input: RecordApprovalDecisionInput,
  row: LockedApprovalTaskRow,
  events: AuditEventInput[],
): Promise<boolean> {
  const nextResult = await transaction.query<NextStageRow>(
    `select id, stage_order, status
       from approval_stage
      where tenant_id = $1::uuid
        and approval_run_id = $2::uuid
        and stage_order = $3::integer
      for update`,
    [input.tenantId, row.run_id, row.stage_order + 1],
  );
  const next = nextResult.rows[0];
  if (!next) return false;
  if (next.status !== "PENDING") throw new ApprovalStageNotInProgressError(next.status);
  const participants = frozenParticipantsForStage(row.resolved_participants, next.stage_order);
  const changedStage = await transaction.query<Record<string, unknown> & { id: string }>(
    `update approval_stage
        set status = 'IN_PROGRESS', row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and status = 'PENDING'
      returning id`,
    [input.tenantId, next.id],
  );
  if (!changedStage.rows[0]) throw new ApprovalStageNotInProgressError(next.status);
  events.push({
    tenantId: input.tenantId,
    eventType: "approval_stage.started",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "APPROVAL_STAGE", id: next.id },
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    documentVersionId: row.document_version_id,
    action: "START_APPROVAL_STAGE",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: null,
    safeAfter: { approvalRunId: row.run_id, stageOrder: next.stage_order, status: "IN_PROGRESS" },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `approval_stage.started:${next.id}`,
  });
  for (const participant of participants) {
    const taskResult = await transaction.query<Record<string, unknown> & { id: string }>(
      `insert into approval_task (
         tenant_id, approval_stage_id, participant_type, participant_id,
         status, assigned_at, due_at, delegated_from_user_id
       ) values ($1::uuid, $2::uuid, $3::approval_participant_type, $4::uuid,
                 'PENDING', $5::timestamptz, null, null)
       returning id`,
      [input.tenantId, next.id, participant.type, participant.id, input.occurredAt.toISOString()],
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
      documentId: row.document_id,
      documentVariantId: row.document_variant_id,
      documentVersionId: row.document_version_id,
      action: "ASSIGN_APPROVAL_TASK",
      outcome: "SUCCESS",
      requestId: input.requestId,
      correlationId: input.correlationId,
      sourceChannel: input.sourceChannel,
      safeBefore: null,
      safeAfter: {
        approvalStageId: next.id,
        participantType: participant.type,
        participantId: participant.id,
        status: "PENDING",
      },
      configurationVersionId: input.configurationVersionId,
      dedupeKey: `approval_task.assigned:${task.id}`,
    });
  }
  return true;
}

/** Record one immutable user decision and advance or terminate its frozen run atomically. */
export async function recordApprovalDecision(
  transaction: AuditTransaction,
  input: RecordApprovalDecisionInput,
): Promise<RecordedApprovalDecision> {
  validateInput(input);
  const row = await lockApprovalTask(transaction, input.tenantId, input.approvalTaskId);
  assertActionable(row, input.decidingUserId);

  const decisionResult = await transaction.query<CreatedDecisionRow>(
    `insert into approval_decision (
       tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
       recorded_by_user_id, recorded_at, content_revision_id, content_digest,
       reason_code, comment_ref, resolution_reference, resolution_date,
       minutes_attachment_id, attending_members, configuration_version_id
     ) values (
       $1::uuid, $2::uuid, $3::approval_decision_kind, 'USER', $4::uuid,
       $4::uuid, $5::timestamptz, $6::uuid, $7::text,
       $8::text, $9::uuid, null, null, null, null, $10::uuid
     )
     returning id, recorded_at`,
    [
      input.tenantId,
      input.approvalTaskId,
      input.decision,
      input.decidingUserId,
      input.occurredAt.toISOString(),
      row.content_revision_id,
      row.content_digest,
      input.reasonCode ?? null,
      input.commentRef ?? null,
      input.configurationVersionId,
    ],
  );
  const created = decisionResult.rows[0];
  if (!created) throw new Error("approval decision insert returned no row");

  const taskResult = await transaction.query<Record<string, unknown> & { id: string }>(
    `update approval_task
        set status = 'DECIDED', row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and status = 'PENDING'
      returning id`,
    [input.tenantId, input.approvalTaskId],
  );
  if (!taskResult.rows[0]) throw new ApprovalTaskNotPendingError(row.task_status);

  const events: AuditEventInput[] = [decisionEvent(input, row, created.id)];
  let runStatus: RecordedApprovalDecision["runStatus"] = "RUNNING";
  let versionLifecycleState: RecordedApprovalDecision["versionLifecycleState"] = "IN_REVIEW";

  if (input.decision === "APPROVE") {
    const counts = await transaction.query<
      Record<string, unknown> & { task_count: number; approval_count: number }
    >(
      `select count(task.id)::int as task_count,
              count(decision.id) filter (where decision.decision = 'APPROVE')::int as approval_count
         from approval_task task
         left join approval_decision decision
           on decision.tenant_id = task.tenant_id
          and decision.approval_task_id = task.id
        where task.tenant_id = $1::uuid and task.approval_stage_id = $2::uuid`,
      [input.tenantId, row.stage_id],
    );
    const count = counts.rows[0];
    if (!count) throw new Error("approval stage count returned no row");
    const satisfied = isApprovalStageSatisfied({
      completionRule: row.completion_rule,
      taskCount: count.task_count,
      approvalCount: count.approval_count,
    });
    if (satisfied) {
      const stageResult = await transaction.query<Record<string, unknown> & { id: string }>(
        `update approval_stage
            set status = 'COMPLETED', completed_at = $3::timestamptz,
                row_version = row_version + 1
          where tenant_id = $1::uuid and id = $2::uuid and status = 'IN_PROGRESS'
          returning id`,
        [input.tenantId, row.stage_id, input.occurredAt.toISOString()],
      );
      if (!stageResult.rows[0]) throw new ApprovalStageNotInProgressError(row.stage_status);
      events.push(
        transitionEvent(input, row, {
          type: "approval_stage.completed",
          subjectType: "APPROVAL_STAGE",
          subjectId: row.stage_id,
          action: "COMPLETE_APPROVAL_STAGE",
          from: "IN_PROGRESS",
          to: "COMPLETED",
        }),
      );

      const nextStageStarted = await startNextStage(transaction, input, row, events);
      if (!nextStageStarted) {
        const runResult = await transaction.query<Record<string, unknown> & { id: string }>(
          `update approval_run
              set status = 'COMPLETED', completed_at = $3::timestamptz,
                  row_version = row_version + 1
            where tenant_id = $1::uuid and id = $2::uuid and status = 'RUNNING'
            returning id`,
          [input.tenantId, row.run_id, input.occurredAt.toISOString()],
        );
        if (!runResult.rows[0]) throw new ApprovalRunNotRunningError(row.run_status);
        events.push(
          transitionEvent(input, row, {
            type: "approval_run.completed",
            subjectType: "APPROVAL_RUN",
            subjectId: row.run_id,
            action: "COMPLETE_APPROVAL_RUN",
            from: "RUNNING",
            to: "COMPLETED",
          }),
        );
        const versionResult = await transaction.query<Record<string, unknown> & { id: string }>(
          `update document_version
              set lifecycle_state = 'APPROVED', approved_at = $3::timestamptz,
                  row_version = row_version + 1
            where tenant_id = $1::uuid and id = $2::uuid and lifecycle_state = 'IN_REVIEW'
            returning id`,
          [input.tenantId, row.document_version_id, input.occurredAt.toISOString()],
        );
        if (!versionResult.rows[0]) throw new ApprovalVersionNotInReviewError(row.lifecycle_state);
        events.push(
          transitionEvent(input, row, {
            type: "version.approved",
            subjectType: "DOCUMENT_VERSION",
            subjectId: row.document_version_id,
            action: "APPROVE_DOCUMENT_VERSION",
            from: "IN_REVIEW",
            to: "APPROVED",
          }),
        );
        runStatus = "COMPLETED";
        versionLifecycleState = "APPROVED";
      }
    }
  } else {
    runStatus = input.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REJECTED";
    versionLifecycleState = runStatus;
    const runResult = await transaction.query<Record<string, unknown> & { id: string }>(
      `update approval_run
          set status = $3::run_status, completed_at = $4::timestamptz,
              row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid and status = 'RUNNING'
        returning id`,
      [input.tenantId, row.run_id, runStatus, input.occurredAt.toISOString()],
    );
    if (!runResult.rows[0]) throw new ApprovalRunNotRunningError(row.run_status);
    const versionResult = await transaction.query<Record<string, unknown> & { id: string }>(
      `update document_version
          set lifecycle_state = $3::version_lifecycle, row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid and lifecycle_state = 'IN_REVIEW'
        returning id`,
      [input.tenantId, row.document_version_id, versionLifecycleState],
    );
    if (!versionResult.rows[0]) throw new ApprovalVersionNotInReviewError(row.lifecycle_state);
    if (input.decision === "REJECT") {
      events.push(
        transitionEvent(input, row, {
          type: "version.rejected",
          subjectType: "DOCUMENT_VERSION",
          subjectId: row.document_version_id,
          action: "REJECT_DOCUMENT_VERSION",
          from: "IN_REVIEW",
          to: "REJECTED",
        }),
      );
    }
  }

  const emittedEvents = await emitAuditEvents(transaction, events);
  return Object.freeze({
    id: created.id,
    approvalTaskId: row.task_id,
    approvalRunId: row.run_id,
    approvalStageId: row.stage_id,
    documentVersionId: row.document_version_id,
    contentRevisionId: row.content_revision_id,
    contentDigest: row.content_digest,
    decision: input.decision,
    recordedAt: created.recorded_at,
    runStatus,
    versionLifecycleState,
    emittedEvents: Object.freeze(emittedEvents),
  });
}
