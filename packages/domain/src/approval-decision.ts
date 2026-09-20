import {
  emitAuditEvents,
  type AuditActorType,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";
import {
  AuthzContext,
  decide as decideAuthorization,
  type DecisionReason,
} from "./authorization.js";

export const APPROVAL_DECISION_REQUIRED_CAPABILITIES = Object.freeze({
  record: "document.approve",
} as const);

export const BODY_RESOLUTION_REQUIRED_CAPABILITIES = Object.freeze({
  record: "body.act_for",
} as const);

export type ApprovalDecisionKind = "APPROVE" | "REQUEST_CHANGES" | "REJECT";
export type ApprovalCompletionRule = "ALL" | "ANY_ONE" | "AT_LEAST_N" | "BODY_RESOLUTION";

interface ApprovalDecisionRequestContext {
  readonly configurationVersionId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sourceChannel: AuditSourceChannel;
}

interface ApprovalDecisionAuditContext extends ApprovalDecisionRequestContext {
  readonly actor: Readonly<{ type: AuditActorType; id: string | null }>;
}

export interface RecordApprovalDecisionInput extends ApprovalDecisionAuditContext {
  readonly tenantId: string;
  readonly approvalTaskId: string;
  readonly decidingUserId: string;
  readonly decision: ApprovalDecisionKind;
  readonly reasonCode?: string | null;
  readonly commentRef?: string | null;
}

export interface RecordBodyResolutionInput extends ApprovalDecisionRequestContext {
  readonly tenantId: string;
  readonly approvalTaskId: string;
  readonly recordedByUserId: string;
  readonly decision: ApprovalDecisionKind;
  readonly reasonCode?: string | null;
  readonly commentRef?: string | null;
  readonly resolutionReference?: string | null;
  readonly resolutionDate?: string | null;
  readonly minutesAttachmentId?: string | null;
  readonly attendingMembers?: readonly string[] | null;
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
  readonly runStatus: "RUNNING" | "BLOCKED" | "COMPLETED" | "CHANGES_REQUESTED" | "REJECTED";
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
    super("BODY_RESOLUTION decisions must be recorded through recordBodyResolution");
    this.name = "ApprovalBodyResolutionRequiredError";
  }
}

export class ApprovalBodyResolutionUnauthorizedError extends Error {
  constructor(readonly because: DecisionReason) {
    super("the recording principal cannot act for this governance body");
    this.name = "ApprovalBodyResolutionUnauthorizedError";
  }
}

export class ApprovalBodyResolutionEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalBodyResolutionEvidenceError";
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

interface BodyMembershipRow extends Record<string, unknown> {
  user_id: string;
  valid_from: Date;
  valid_until: Date | null;
}

interface NextStageRow extends Record<string, unknown> {
  id: string;
  stage_order: number;
  status: string;
}

interface ParticipantStatusRow extends Record<string, unknown> {
  status: string;
}

interface FrozenParticipant {
  readonly type: "USER" | "GOVERNANCE_BODY";
  readonly id: string;
  readonly displayName: string;
}

export interface ApprovalParticipantEligibility {
  readonly participantType: "USER" | "GOVERNANCE_BODY";
  readonly status: string;
}

interface DecisionExecutionInput extends ApprovalDecisionAuditContext {
  readonly tenantId: string;
  readonly approvalTaskId: string;
  readonly decision: ApprovalDecisionKind;
  readonly decidedByType: "USER" | "BODY";
  readonly decidedById: string;
  readonly recordedByUserId: string;
  readonly reasonCode: string | null;
  readonly commentRef: string | null;
  readonly resolutionReference: string | null;
  readonly resolutionDate: string | null;
  readonly minutesAttachmentId: string | null;
  readonly attendingMembers: readonly string[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECISIONS = new Set<ApprovalDecisionKind>(["APPROVE", "REQUEST_CHANGES", "REJECT"]);
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

/** Pilot eligibility is deliberately narrow and never substitutes another participant. */
export function isApprovalParticipantEligible(input: ApprovalParticipantEligibility): boolean {
  return input.status === "ACTIVE";
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) throw new TypeError(`${field} must be an ISO calendar date`);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be an ISO calendar date`);
  }
}

function validateRequestContext(
  input: ApprovalDecisionRequestContext & { tenantId: string },
): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.valueOf())) {
    throw new TypeError("occurredAt must be a valid Date");
  }
}

function validateInput(input: RecordApprovalDecisionInput): void {
  validateRequestContext(input);
  requireUuid(input.approvalTaskId, "approvalTaskId");
  requireUuid(input.decidingUserId, "decidingUserId");
  if (!DECISIONS.has(input.decision)) throw new TypeError("decision is not supported");
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  if (input.actor.type !== "USER" || input.actor.id !== input.decidingUserId) {
    throw new ApprovalTaskNotHeldError();
  }
  if (input.commentRef !== undefined && input.commentRef !== null) {
    requireUuid(input.commentRef, "commentRef");
  }
}

function validateBodyResolutionInput(
  authorizationContext: AuthzContext,
  input: RecordBodyResolutionInput,
): void {
  validateRequestContext(input);
  requireUuid(input.approvalTaskId, "approvalTaskId");
  requireUuid(input.recordedByUserId, "recordedByUserId");
  if (!DECISIONS.has(input.decision)) throw new TypeError("decision is not supported");
  if (input.commentRef !== undefined && input.commentRef !== null) {
    requireUuid(input.commentRef, "commentRef");
  }
  if (input.minutesAttachmentId !== undefined && input.minutesAttachmentId !== null) {
    requireUuid(input.minutesAttachmentId, "minutesAttachmentId");
  }
  if (input.resolutionDate !== undefined && input.resolutionDate !== null) {
    requireIsoDate(input.resolutionDate, "resolutionDate");
  }
  if (input.attendingMembers !== undefined && input.attendingMembers !== null) {
    input.attendingMembers.forEach((member, index) =>
      requireUuid(member, `attendingMembers[${index}]`),
    );
    if (input.attendingMembers.length > 0 && !input.resolutionDate) {
      throw new ApprovalBodyResolutionEvidenceError(
        "resolutionDate is required when attendingMembers are recorded",
      );
    }
  }
  if (!(authorizationContext instanceof AuthzContext)) {
    throw new TypeError("authorizationContext must be an AuthzContext");
  }
  if (authorizationContext.tenantId !== input.tenantId) {
    throw new ApprovalBodyResolutionUnauthorizedError("WRONG_TENANT");
  }
  if (
    authorizationContext.principal.type !== "USER" ||
    authorizationContext.principal.id !== input.recordedByUserId
  ) {
    throw new ApprovalBodyResolutionUnauthorizedError("NO_GRANT");
  }
}

export interface DatedBodyMembership {
  readonly userId: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

/** Ensure every recorded attendee held a seat at some instant on the resolution date. */
export function assertAttendingMembersHeldSeats(
  attendingMembers: readonly string[],
  memberships: readonly DatedBodyMembership[],
  resolutionDate: string,
): void {
  requireIsoDate(resolutionDate, "resolutionDate");
  const dayStart = new Date(`${resolutionDate}T00:00:00.000Z`).valueOf();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const seated = new Set(
    memberships
      .filter(
        ({ validFrom, validUntil }) =>
          validFrom.valueOf() < dayEnd && (validUntil === null || validUntil.valueOf() > dayStart),
      )
      .map(({ userId }) => userId),
  );
  if (attendingMembers.some((member) => !seated.has(member))) {
    throw new ApprovalBodyResolutionEvidenceError(
      "every attending member must hold a seat on the deciding body at the resolution date",
    );
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
  // Cancellation locks the governed version first. Use the same order here so a
  // simultaneous decision and cancellation serialize instead of forming a lock cycle.
  const versionResult = await transaction.query<Record<string, unknown> & { id: string }>(
    `select version.id
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
      where task.tenant_id = $1::uuid and task.id = $2::uuid`,
    [tenantId, approvalTaskId],
  );
  const versionId = versionResult.rows[0]?.id;
  if (!versionId) throw new ApprovalTaskNotFoundError();
  await transaction.query(
    `select id from document_version
      where tenant_id = $1::uuid and id = $2::uuid
      for update`,
    [tenantId, versionId],
  );

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

function assertActionable(row: LockedApprovalTaskRow): void {
  if (row.task_status !== "PENDING") throw new ApprovalTaskNotPendingError(row.task_status);
  if (row.stage_status !== "IN_PROGRESS") {
    throw new ApprovalStageNotInProgressError(row.stage_status);
  }
  if (row.run_status !== "RUNNING") throw new ApprovalRunNotRunningError(row.run_status);
  if (row.lifecycle_state !== "IN_REVIEW") {
    throw new ApprovalVersionNotInReviewError(row.lifecycle_state);
  }
}

function assertUserActionable(row: LockedApprovalTaskRow, decidingUserId: string): void {
  assertActionable(row);
  if (row.completion_rule === "BODY_RESOLUTION") throw new ApprovalBodyResolutionRequiredError();
  if (row.participant_type !== "USER" || row.participant_id !== decidingUserId) {
    throw new ApprovalTaskNotHeldError();
  }
}

function assertBodyResolutionActionable(row: LockedApprovalTaskRow): void {
  assertActionable(row);
  if (row.completion_rule !== "BODY_RESOLUTION" || row.participant_type !== "GOVERNANCE_BODY") {
    throw new ApprovalBodyResolutionRequiredError();
  }
  const participants = frozenParticipantsForStage(row.resolved_participants, row.stage_order);
  if (
    participants.length !== 1 ||
    participants[0]?.type !== "GOVERNANCE_BODY" ||
    participants[0].id !== row.participant_id
  ) {
    throw new InvalidApprovalRunSnapshotError();
  }
}

function decisionEvent(
  input: DecisionExecutionInput,
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
      decidedByType: input.decidedByType,
      decidedById: input.decidedById,
      contentRevisionId: row.content_revision_id,
      contentDigest: row.content_digest,
      decision: input.decision,
    },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `${eventType[input.decision]}:${decisionId}`,
  };
}

function transitionEvent(
  input: DecisionExecutionInput,
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
  input: DecisionExecutionInput,
  row: LockedApprovalTaskRow,
  events: AuditEventInput[],
): Promise<"NONE" | "STARTED" | "BLOCKED"> {
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
  if (!next) return "NONE";
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
  const unresolvableEvents: AuditEventInput[] = [];
  let blocked = false;
  for (const participant of participants) {
    const participantResult =
      participant.type === "USER"
        ? await transaction.query<ParticipantStatusRow>(
            `select status::text as status
               from app_user
              where tenant_id = $1::uuid and id = $2::uuid`,
            [input.tenantId, participant.id],
          )
        : await transaction.query<ParticipantStatusRow>(
            `select status::text as status
               from governance_body
              where tenant_id = $1::uuid and id = $2::uuid`,
            [input.tenantId, participant.id],
          );
    const participantStatus = participantResult.rows[0]?.status ?? "NOT_FOUND";
    const eligible = isApprovalParticipantEligible({
      participantType: participant.type,
      status: participantStatus,
    });
    const taskStatus = eligible ? "PENDING" : "UNRESOLVABLE";
    blocked ||= !eligible;
    const taskResult = await transaction.query<Record<string, unknown> & { id: string }>(
      `insert into approval_task (
         tenant_id, approval_stage_id, participant_type, participant_id,
         status, assigned_at, due_at, delegated_from_user_id
       ) values ($1::uuid, $2::uuid, $3::approval_participant_type, $4::uuid,
                 $5::approval_task_status, $6::timestamptz, null, null)
       returning id`,
      [
        input.tenantId,
        next.id,
        participant.type,
        participant.id,
        taskStatus,
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
        status: taskStatus,
      },
      configurationVersionId: input.configurationVersionId,
      dedupeKey: `approval_task.assigned:${task.id}`,
    });
    if (!eligible) {
      unresolvableEvents.push({
        tenantId: input.tenantId,
        eventType: "approval_task.unresolvable",
        eventSchemaVersion: 1,
        occurredAt: input.occurredAt,
        actor: input.actor,
        subject: { type: "APPROVAL_TASK", id: task.id },
        documentId: row.document_id,
        documentVariantId: row.document_variant_id,
        documentVersionId: row.document_version_id,
        action: "MARK_APPROVAL_TASK_UNRESOLVABLE",
        outcome: "SUCCESS",
        requestId: input.requestId,
        correlationId: input.correlationId,
        sourceChannel: input.sourceChannel,
        safeBefore: null,
        safeAfter: {
          approvalStageId: next.id,
          participantType: participant.type,
          participantId: participant.id,
          status: "UNRESOLVABLE",
          participantStatus,
        },
        configurationVersionId: input.configurationVersionId,
        dedupeKey: `approval_task.unresolvable:${task.id}`,
      });
    }
  }
  if (!blocked) return "STARTED";

  const blockedStage = await transaction.query<Record<string, unknown> & { id: string }>(
    `update approval_stage
        set status = 'BLOCKED', row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and status = 'IN_PROGRESS'
      returning id`,
    [input.tenantId, next.id],
  );
  if (!blockedStage.rows[0]) throw new ApprovalStageNotInProgressError("IN_PROGRESS");
  const blockedRun = await transaction.query<Record<string, unknown> & { id: string }>(
    `update approval_run
        set status = 'BLOCKED', row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and status = 'RUNNING'
      returning id`,
    [input.tenantId, row.run_id],
  );
  if (!blockedRun.rows[0]) throw new ApprovalRunNotRunningError(row.run_status);
  events.push(...unresolvableEvents, {
    tenantId: input.tenantId,
    eventType: "approval_run.blocked",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "APPROVAL_RUN", id: row.run_id },
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    documentVersionId: row.document_version_id,
    action: "BLOCK_APPROVAL_RUN",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: { status: "RUNNING" },
    safeAfter: { status: "BLOCKED" },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `approval_run.blocked:${row.run_id}`,
  });
  return "BLOCKED";
}

async function executeApprovalDecision(
  transaction: AuditTransaction,
  input: DecisionExecutionInput,
  row: LockedApprovalTaskRow,
): Promise<RecordedApprovalDecision> {
  const decisionResult = await transaction.query<CreatedDecisionRow>(
    `insert into approval_decision (
       tenant_id, approval_task_id, decision, decided_by_type, decided_by_id,
       recorded_by_user_id, recorded_at, content_revision_id, content_digest,
       reason_code, comment_ref, resolution_reference, resolution_date,
       minutes_attachment_id, attending_members, configuration_version_id
     ) values (
       $1::uuid, $2::uuid, $3::approval_decision_kind, $4::text, $5::uuid,
       $6::uuid, $7::timestamptz, $8::uuid, $9::text,
       $10::text, $11::uuid, $12::text, $13::date, $14::uuid, $15::uuid[], $16::uuid
     )
     returning id, recorded_at`,
    [
      input.tenantId,
      input.approvalTaskId,
      input.decision,
      input.decidedByType,
      input.decidedById,
      input.recordedByUserId,
      input.occurredAt.toISOString(),
      row.content_revision_id,
      row.content_digest,
      input.reasonCode,
      input.commentRef,
      input.resolutionReference,
      input.resolutionDate,
      input.minutesAttachmentId,
      input.attendingMembers,
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
    const satisfied =
      input.decidedByType === "BODY"
        ? count.task_count === 1 && count.approval_count === 1
        : isApprovalStageSatisfied({
            completionRule: row.completion_rule,
            taskCount: count.task_count,
            approvalCount: count.approval_count,
          });
    if (input.decidedByType === "BODY" && !satisfied) {
      throw new InvalidApprovalRunSnapshotError();
    }
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

      const nextStageOutcome = await startNextStage(transaction, input, row, events);
      if (nextStageOutcome === "BLOCKED") {
        runStatus = "BLOCKED";
      } else if (nextStageOutcome === "NONE") {
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

/** Record one immutable user decision and advance or terminate its frozen run atomically. */
export async function recordApprovalDecision(
  transaction: AuditTransaction,
  input: RecordApprovalDecisionInput,
): Promise<RecordedApprovalDecision> {
  validateInput(input);
  const row = await lockApprovalTask(transaction, input.tenantId, input.approvalTaskId);
  assertUserActionable(row, input.decidingUserId);
  return executeApprovalDecision(
    transaction,
    {
      tenantId: input.tenantId,
      approvalTaskId: input.approvalTaskId,
      decision: input.decision,
      decidedByType: "USER",
      decidedById: input.decidingUserId,
      recordedByUserId: input.decidingUserId,
      actor: input.actor,
      reasonCode: input.reasonCode ?? null,
      commentRef: input.commentRef ?? null,
      resolutionReference: null,
      resolutionDate: null,
      minutesAttachmentId: null,
      attendingMembers: null,
      configurationVersionId: input.configurationVersionId,
      occurredAt: input.occurredAt,
      requestId: input.requestId,
      correlationId: input.correlationId,
      sourceChannel: input.sourceChannel,
    },
    row,
  );
}

async function assertAttendingMembersForBody(
  transaction: AuditTransaction,
  tenantId: string,
  bodyId: string,
  attendingMembers: readonly string[] | null,
  resolutionDate: string | null,
): Promise<void> {
  if (!attendingMembers || attendingMembers.length === 0) return;
  if (!resolutionDate) {
    throw new ApprovalBodyResolutionEvidenceError(
      "resolutionDate is required when attendingMembers are recorded",
    );
  }
  const result = await transaction.query<BodyMembershipRow>(
    `select user_id, lower(validity) as valid_from, upper(validity) as valid_until
       from body_membership
      where tenant_id = $1::uuid
        and body_id = $2::uuid
        and user_id = any($3::uuid[])
      for share`,
    [tenantId, bodyId, attendingMembers],
  );
  assertAttendingMembersHeldSeats(
    attendingMembers,
    result.rows.map((membership) => ({
      userId: membership.user_id,
      validFrom: membership.valid_from,
      validUntil: membership.valid_until,
    })),
    resolutionDate,
  );
}

/** Record one institutional decision after authorizing its human recorder for that exact body. */
export async function recordBodyResolution(
  transaction: AuditTransaction,
  authorizationContext: AuthzContext,
  input: RecordBodyResolutionInput,
): Promise<RecordedApprovalDecision> {
  validateBodyResolutionInput(authorizationContext, input);
  const row = await lockApprovalTask(transaction, input.tenantId, input.approvalTaskId);
  assertBodyResolutionActionable(row);

  const authorization = await decideAuthorization(
    authorizationContext,
    BODY_RESOLUTION_REQUIRED_CAPABILITIES.record,
    { tenantId: input.tenantId, type: "GOVERNANCE_BODY", id: row.participant_id },
  );
  if (!authorization.allowed) {
    throw new ApprovalBodyResolutionUnauthorizedError(authorization.because);
  }

  const attendingMembers =
    input.attendingMembers === undefined || input.attendingMembers === null
      ? null
      : Object.freeze([...input.attendingMembers]);
  const resolutionDate = input.resolutionDate ?? null;
  await assertAttendingMembersForBody(
    transaction,
    input.tenantId,
    row.participant_id,
    attendingMembers,
    resolutionDate,
  );

  return executeApprovalDecision(
    transaction,
    {
      tenantId: input.tenantId,
      approvalTaskId: input.approvalTaskId,
      decision: input.decision,
      decidedByType: "BODY",
      decidedById: row.participant_id,
      recordedByUserId: input.recordedByUserId,
      actor: Object.freeze({ type: "BODY", id: row.participant_id }),
      reasonCode: input.reasonCode ?? null,
      commentRef: input.commentRef ?? null,
      resolutionReference: input.resolutionReference ?? null,
      resolutionDate,
      minutesAttachmentId: input.minutesAttachmentId ?? null,
      attendingMembers,
      configurationVersionId: input.configurationVersionId,
      occurredAt: input.occurredAt,
      requestId: input.requestId,
      correlationId: input.correlationId,
      sourceChannel: input.sourceChannel,
    },
    row,
  );
}
