import { BODY_RESOLUTION_REQUIRED_CAPABILITIES } from "./approval-decision.js";
import { decide, type AuthzContext } from "./authorization.js";
import type { AuditTransaction } from "./audit.js";

export type ApprovalInboxParticipantType = "USER" | "GOVERNANCE_BODY";
export type ApprovalInboxTaskStatus = "PENDING" | "UNRESOLVABLE";
export type ApprovalInboxRunStatus = "RUNNING" | "BLOCKED";

export interface ApprovalInboxDecision {
  readonly id: string;
  readonly decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT";
  readonly decidedBy: Readonly<{
    type: "USER" | "BODY";
    id: string;
    name: string;
  }>;
  readonly recordedBy: Readonly<{ id: string; name: string }>;
  readonly recordedAt: Date;
  readonly contentRevisionId: string;
  readonly contentDigest: string;
  readonly reasonCode: string | null;
  readonly resolutionReference: string | null;
  readonly resolutionDate: string | null;
  readonly minutesAttachmentId: string | null;
  readonly attendingMembers: readonly string[] | null;
}

export interface ApprovalInboxApplicabilityRule {
  readonly id: string;
  readonly effect: "INCLUDE" | "EXCLUDE";
  readonly inheritanceMode: "MANDATORY" | "DEFAULT" | "LOCAL_ONLY";
  readonly legalEntities: readonly ApprovalInboxScopeTarget[];
  readonly orgUnits: readonly ApprovalInboxScopeTarget[];
  readonly jurisdictions: readonly ApprovalInboxScopeTarget[];
  readonly groups: readonly ApprovalInboxScopeTarget[];
  readonly users: readonly ApprovalInboxScopeTarget[];
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

export interface ApprovalInboxScopeTarget {
  readonly id: string;
  readonly name: string;
}

export interface ApprovalInboxItem {
  readonly task: Readonly<{
    id: string;
    status: ApprovalInboxTaskStatus;
    participant: Readonly<{
      type: ApprovalInboxParticipantType;
      id: string;
      name: string;
    }>;
    assignedAt: Date;
    dueAt: Date | null;
  }>;
  readonly document: Readonly<{
    id: string;
    code: string;
    title: string;
  }>;
  readonly version: Readonly<{
    id: string;
    displayLabel: string | null;
    materiality: "EDITORIAL" | "NON_MATERIAL" | "MATERIAL" | "EMERGENCY" | null;
    changeSummary: string | null;
  }>;
  readonly revision: Readonly<{
    id: string;
    digest: string;
    submittedAt: Date;
  }>;
  readonly scope: Readonly<{
    orgUnitId: string;
    orgUnitCode: string;
    orgUnitName: string;
    applicabilityRules: readonly ApprovalInboxApplicabilityRule[];
  }>;
  readonly stage: Readonly<{
    id: string;
    order: number;
    completionRule: "ALL" | "ANY_ONE" | "AT_LEAST_N" | "BODY_RESOLUTION";
    threshold: number | null;
    status: "IN_PROGRESS" | "BLOCKED";
    dueAt: Date | null;
  }>;
  readonly run: Readonly<{
    id: string;
    status: ApprovalInboxRunStatus;
    startedAt: Date;
  }>;
  readonly priorDecisions: readonly ApprovalInboxDecision[];
}

interface ApprovalInboxRow extends Record<string, unknown> {
  task_id: string;
  task_status: ApprovalInboxTaskStatus;
  participant_type: ApprovalInboxParticipantType;
  participant_id: string;
  participant_name: string;
  assigned_at: Date;
  task_due_at: Date | null;
  document_id: string;
  document_code: string;
  document_title: string;
  version_id: string;
  display_label: string | null;
  materiality: ApprovalInboxItem["version"]["materiality"];
  change_summary: string | null;
  revision_id: string;
  content_digest: string;
  submitted_at: Date;
  org_unit_id: string;
  org_unit_code: string;
  org_unit_name: string;
  stage_id: string;
  stage_order: number;
  completion_rule: ApprovalInboxItem["stage"]["completionRule"];
  threshold: number | null;
  stage_status: ApprovalInboxItem["stage"]["status"];
  stage_due_at: Date | null;
  run_id: string;
  run_status: ApprovalInboxRunStatus;
  run_started_at: Date;
}

interface ApprovalInboxDecisionRow extends Record<string, unknown> {
  run_id: string;
  decision_id: string;
  decision: ApprovalInboxDecision["decision"];
  decided_by_type: ApprovalInboxDecision["decidedBy"]["type"];
  decided_by_id: string;
  decided_by_name: string;
  recorded_by_user_id: string;
  recorded_by_name: string;
  recorded_at: Date;
  content_revision_id: string;
  content_digest: string;
  reason_code: string | null;
  resolution_reference: string | null;
  resolution_date: string | null;
  minutes_attachment_id: string | null;
  attending_members: string[] | null;
}

interface ApprovalInboxApplicabilityRow extends Record<string, unknown> {
  version_id: string;
  rule_id: string;
  effect: ApprovalInboxApplicabilityRule["effect"];
  inheritance_mode: ApprovalInboxApplicabilityRule["inheritanceMode"];
  legal_entities: unknown;
  org_units: unknown;
  jurisdictions: unknown;
  groups: unknown;
  users: unknown;
  valid_from: Date;
  valid_until: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_WORK_QUERY = `
select task.id as task_id,
       task.status as task_status,
       task.participant_type,
       task.participant_id,
       case task.participant_type
         when 'USER' then task_user.display_name
         when 'GOVERNANCE_BODY' then body.name
       end as participant_name,
       task.assigned_at,
       task.due_at as task_due_at,
       document.id as document_id,
       document.document_code,
       document.canonical_title as document_title,
       version.id as version_id,
       version.display_label,
       version.materiality,
       version.change_summary,
       revision.id as revision_id,
       revision.content_digest,
       revision.submitted_at,
       scope.id as org_unit_id,
       scope.code as org_unit_code,
       scope.name as org_unit_name,
       stage.id as stage_id,
       stage.stage_order,
       stage.completion_rule,
       stage.threshold,
       stage.status as stage_status,
       stage.due_at as stage_due_at,
       run.id as run_id,
       run.status as run_status,
       run.started_at as run_started_at
  from approval_task task
  join approval_stage stage
    on stage.tenant_id = task.tenant_id
   and stage.id = task.approval_stage_id
  join approval_run run
    on run.tenant_id = stage.tenant_id
   and run.id = stage.approval_run_id
  join content_revision revision
    on revision.tenant_id = run.tenant_id
   and revision.id = run.content_revision_id
  join document_version version
    on version.tenant_id = revision.tenant_id
   and version.id = revision.document_version_id
  join document_variant variant
    on variant.tenant_id = version.tenant_id
   and variant.id = version.document_variant_id
  join document
    on document.tenant_id = variant.tenant_id
   and document.id = variant.document_id
  join org_unit scope
    on scope.tenant_id = document.tenant_id
   and scope.id = document.owning_org_unit_id
  left join app_user task_user
    on task_user.tenant_id = task.tenant_id
   and task_user.id = task.participant_id
   and task.participant_type = 'USER'
  left join governance_body body
    on body.tenant_id = task.tenant_id
   and body.id = task.participant_id
   and task.participant_type = 'GOVERNANCE_BODY'
 where task.tenant_id = $1::uuid
   and task.participant_type in ('USER', 'GOVERNANCE_BODY')
   and task.status in ('PENDING', 'UNRESOLVABLE')
   and stage.status in ('IN_PROGRESS', 'BLOCKED')
   and run.status in ('RUNNING', 'BLOCKED')
   and revision.submitted_at is not null`;

const APPROVAL_APPLICABILITY_QUERY = `
select rule.authorised_by_version_id as version_id,
       rule.id as rule_id,
       rule.effect,
       rule.inheritance_mode,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object('id', entity.id, 'name', entity.legal_name)
             order by entity.id
           )
             from legal_entity entity
            where entity.tenant_id = rule.tenant_id
              and entity.id = any(rule.legal_entity_ids)
         ),
         '[]'::jsonb
       ) as legal_entities,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object('id', unit.id, 'name', unit.name || ' (' || unit.code || ')')
             order by unit.id
           )
             from org_unit unit
            where unit.tenant_id = rule.tenant_id
              and unit.id = any(rule.org_unit_ids)
         ),
         '[]'::jsonb
       ) as org_units,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object(
               'id', jurisdiction.id,
               'name', jurisdiction.name || ' (' || jurisdiction.code || ')'
             )
             order by jurisdiction.id
           )
             from jurisdiction
            where jurisdiction.tenant_id = rule.tenant_id
              and jurisdiction.id = any(rule.jurisdiction_ids)
         ),
         '[]'::jsonb
       ) as jurisdictions,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object('id', user_group.id, 'name', user_group.name)
             order by user_group.id
           )
             from user_group
            where user_group.tenant_id = rule.tenant_id
              and user_group.id = any(rule.group_ids)
         ),
         '[]'::jsonb
       ) as groups,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object('id', app_user.id, 'name', app_user.display_name)
             order by app_user.id
           )
             from app_user
            where app_user.tenant_id = rule.tenant_id
              and app_user.id = any(rule.user_ids)
         ),
         '[]'::jsonb
       ) as users,
       lower(rule.validity) as valid_from,
       upper(rule.validity) as valid_until
  from applicability_rule rule
 where rule.tenant_id = $1::uuid
   and rule.authorised_by_version_id = any($2::uuid[])
 order by rule.authorised_by_version_id, rule.id`;

const APPROVAL_DECISIONS_QUERY = `
select decided_stage.approval_run_id as run_id,
       decision.id as decision_id,
       decision.decision,
       decision.decided_by_type,
       decision.decided_by_id,
       case decision.decided_by_type
         when 'USER' then deciding_user.display_name
         when 'BODY' then deciding_body.name
       end as decided_by_name,
       decision.recorded_by_user_id,
       recorder.display_name as recorded_by_name,
       decision.recorded_at,
       decision.content_revision_id,
       decision.content_digest,
       decision.reason_code,
       decision.resolution_reference,
       decision.resolution_date::text,
       decision.minutes_attachment_id,
       decision.attending_members
  from approval_decision decision
  join approval_task decided_task
    on decided_task.tenant_id = decision.tenant_id
   and decided_task.id = decision.approval_task_id
  join approval_stage decided_stage
    on decided_stage.tenant_id = decided_task.tenant_id
   and decided_stage.id = decided_task.approval_stage_id
  join app_user recorder
    on recorder.tenant_id = decision.tenant_id
   and recorder.id = decision.recorded_by_user_id
  left join app_user deciding_user
    on deciding_user.tenant_id = decision.tenant_id
   and deciding_user.id = decision.decided_by_id
   and decision.decided_by_type = 'USER'
  left join governance_body deciding_body
    on deciding_body.tenant_id = decision.tenant_id
   and deciding_body.id = decision.decided_by_id
   and decision.decided_by_type = 'BODY'
 where decision.tenant_id = $1::uuid
   and decided_stage.approval_run_id = any($2::uuid[])
 order by decision.recorded_at, decision.id`;

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

async function principalOwnsTask(context: AuthzContext, row: ApprovalInboxRow): Promise<boolean> {
  if (context.principal.type !== "USER") return false;
  if (row.participant_type === "USER") return row.participant_id === context.principal.id;
  const authorization = await decide(context, BODY_RESOLUTION_REQUIRED_CAPABILITIES.record, {
    tenantId: context.tenantId,
    type: "GOVERNANCE_BODY",
    id: row.participant_id,
  });
  return authorization.allowed;
}

function decisionFromRow(row: ApprovalInboxDecisionRow): ApprovalInboxDecision {
  return Object.freeze({
    id: row.decision_id,
    decision: row.decision,
    decidedBy: Object.freeze({
      type: row.decided_by_type,
      id: row.decided_by_id,
      name: row.decided_by_name,
    }),
    recordedBy: Object.freeze({
      id: row.recorded_by_user_id,
      name: row.recorded_by_name,
    }),
    recordedAt: row.recorded_at,
    contentRevisionId: row.content_revision_id,
    contentDigest: row.content_digest,
    reasonCode: row.reason_code,
    resolutionReference: row.resolution_reference,
    resolutionDate: row.resolution_date,
    minutesAttachmentId: row.minutes_attachment_id,
    attendingMembers:
      row.attending_members === null ? null : Object.freeze([...row.attending_members]),
  });
}

function itemFromRow(
  row: ApprovalInboxRow,
  decisions: readonly ApprovalInboxDecision[],
  applicabilityRules: readonly ApprovalInboxApplicabilityRule[],
): ApprovalInboxItem {
  return Object.freeze({
    task: Object.freeze({
      id: row.task_id,
      status: row.task_status,
      participant: Object.freeze({
        type: row.participant_type,
        id: row.participant_id,
        name: row.participant_name,
      }),
      assignedAt: row.assigned_at,
      dueAt: row.task_due_at,
    }),
    document: Object.freeze({
      id: row.document_id,
      code: row.document_code,
      title: row.document_title,
    }),
    version: Object.freeze({
      id: row.version_id,
      displayLabel: row.display_label,
      materiality: row.materiality,
      changeSummary: row.change_summary,
    }),
    revision: Object.freeze({
      id: row.revision_id,
      digest: row.content_digest,
      submittedAt: row.submitted_at,
    }),
    scope: Object.freeze({
      orgUnitId: row.org_unit_id,
      orgUnitCode: row.org_unit_code,
      orgUnitName: row.org_unit_name,
      applicabilityRules: Object.freeze([...applicabilityRules]),
    }),
    stage: Object.freeze({
      id: row.stage_id,
      order: row.stage_order,
      completionRule: row.completion_rule,
      threshold: row.threshold,
      status: row.stage_status,
      dueAt: row.stage_due_at,
    }),
    run: Object.freeze({
      id: row.run_id,
      status: row.run_status,
      startedAt: row.run_started_at,
    }),
    priorDecisions: Object.freeze([...decisions]),
  });
}

function applicabilityRuleFromRow(
  row: ApprovalInboxApplicabilityRow,
): ApprovalInboxApplicabilityRule {
  return Object.freeze({
    id: row.rule_id,
    effect: row.effect,
    inheritanceMode: row.inheritance_mode,
    legalEntities: scopeTargets(row.legal_entities, "legalEntities"),
    orgUnits: scopeTargets(row.org_units, "orgUnits"),
    jurisdictions: scopeTargets(row.jurisdictions, "jurisdictions"),
    groups: scopeTargets(row.groups, "groups"),
    users: scopeTargets(row.users, "users"),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  });
}

function scopeTargets(value: unknown, field: string): readonly ApprovalInboxScopeTarget[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return Object.freeze(
    value.map((candidate, index) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new TypeError(`${field}[${index}] must be an object`);
      }
      const target = candidate as Record<string, unknown>;
      if (
        typeof target.id !== "string" ||
        !UUID.test(target.id) ||
        typeof target.name !== "string" ||
        target.name.trim().length === 0
      ) {
        throw new TypeError(`${field}[${index}] is invalid`);
      }
      return Object.freeze({ id: target.id, name: target.name });
    }),
  );
}

async function decisionsByRun(
  transaction: AuditTransaction,
  tenantId: string,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ApprovalInboxDecision[]>> {
  if (runIds.length === 0) return new Map();
  const result = await transaction.query<ApprovalInboxDecisionRow>(APPROVAL_DECISIONS_QUERY, [
    tenantId,
    runIds,
  ]);
  const decisions = new Map<string, ApprovalInboxDecision[]>();
  for (const row of result.rows) {
    const current = decisions.get(row.run_id) ?? [];
    current.push(decisionFromRow(row));
    decisions.set(row.run_id, current);
  }
  return decisions;
}

async function applicabilityByVersion(
  transaction: AuditTransaction,
  tenantId: string,
  versionIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ApprovalInboxApplicabilityRule[]>> {
  if (versionIds.length === 0) return new Map();
  const result = await transaction.query<ApprovalInboxApplicabilityRow>(
    APPROVAL_APPLICABILITY_QUERY,
    [tenantId, versionIds],
  );
  const rules = new Map<string, ApprovalInboxApplicabilityRule[]>();
  for (const row of result.rows) {
    const current = rules.get(row.version_id) ?? [];
    current.push(applicabilityRuleFromRow(row));
    rules.set(row.version_id, current);
  }
  return rules;
}

async function ownedRows(
  transaction: AuditTransaction,
  context: AuthzContext,
  taskId?: string,
): Promise<ApprovalInboxRow[]> {
  const taskPredicate = taskId === undefined ? "" : " and task.id = $2::uuid";
  const result = await transaction.query<ApprovalInboxRow>(
    `${APPROVAL_WORK_QUERY}${taskPredicate}
     order by run.started_at, stage.stage_order, task.id`,
    taskId === undefined ? [context.tenantId] : [context.tenantId, taskId],
  );
  const ownership = await Promise.all(result.rows.map((row) => principalOwnsTask(context, row)));
  return result.rows.filter((_, index) => ownership[index]);
}

/** List only open work owned by the authenticated principal or a body they may represent. */
export async function listApprovalInbox(
  transaction: AuditTransaction,
  context: AuthzContext,
): Promise<ApprovalInboxItem[]> {
  requireUuid(context.tenantId, "tenantId");
  const rows = await ownedRows(transaction, context);
  const runIds = [...new Set(rows.map((row) => row.run_id))];
  const versionIds = [...new Set(rows.map((row) => row.version_id))];
  const [decisions, applicability] = await Promise.all([
    decisionsByRun(transaction, context.tenantId, runIds),
    applicabilityByVersion(transaction, context.tenantId, versionIds),
  ]);
  return rows.map((row) =>
    itemFromRow(row, decisions.get(row.run_id) ?? [], applicability.get(row.version_id) ?? []),
  );
}

/** Resolve one owned open task; foreign, cross-tenant and unowned identifiers are identical. */
export async function getApprovalInboxItem(
  transaction: AuditTransaction,
  context: AuthzContext,
  taskId: string,
): Promise<ApprovalInboxItem | null> {
  requireUuid(context.tenantId, "tenantId");
  requireUuid(taskId, "taskId");
  const rows = await ownedRows(transaction, context, taskId);
  const row = rows[0];
  if (!row) return null;
  const [decisions, applicability] = await Promise.all([
    decisionsByRun(transaction, context.tenantId, [row.run_id]),
    applicabilityByVersion(transaction, context.tenantId, [row.version_id]),
  ]);
  return itemFromRow(row, decisions.get(row.run_id) ?? [], applicability.get(row.version_id) ?? []);
}
