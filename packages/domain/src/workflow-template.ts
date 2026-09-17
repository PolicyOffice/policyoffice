import type { AuditTransaction } from "./audit.js";
import { MATERIALITY_CLASSES, type Materiality } from "./version.js";

export type MaterialityClass = Materiality;

export const WORKFLOW_PARTICIPANT_TYPES = [
  "USER",
  "ROLE_AT_SCOPE",
  "GROUP",
  "GOVERNANCE_BODY",
] as const;
export type WorkflowParticipantType = (typeof WORKFLOW_PARTICIPANT_TYPES)[number];

export const WORKFLOW_COMPLETION_RULES = [
  "ALL",
  "ANY_ONE",
  "AT_LEAST_N",
  "BODY_RESOLUTION",
] as const;
export type WorkflowCompletionRule = (typeof WORKFLOW_COMPLETION_RULES)[number];

export const WORKFLOW_TEMPLATE_REQUIRED_CAPABILITIES = Object.freeze({
  publish: "tenant.manage_configuration",
  assignToDocumentType: "tenant.manage_configuration",
} as const);

export interface WorkflowParticipant {
  readonly type: WorkflowParticipantType;
  readonly id: string;
}

export interface WorkflowStage {
  readonly order: number;
  readonly name: string;
  readonly completionRule: WorkflowCompletionRule;
  readonly threshold?: number;
  readonly participants: readonly WorkflowParticipant[];
}

export type MandatedAuthority = Readonly<
  Partial<Record<MaterialityClass, Readonly<{ requires: readonly WorkflowParticipant[] }>>>
>;

export interface ActiveWorkflowParticipants {
  readonly userIds: ReadonlySet<string>;
  readonly governanceBodyIds: ReadonlySet<string>;
}

export type WorkflowTemplateValidationCode =
  | "STAGES_NOT_ARRAY"
  | "STAGES_EMPTY"
  | "STAGE_NOT_OBJECT"
  | "STAGE_FIELDS_INVALID"
  | "STAGE_ORDER_INVALID"
  | "STAGE_NAME_REQUIRED"
  | "COMPLETION_RULE_INVALID"
  | "COMPLETION_RULE_UNSUPPORTED_IN_PILOT"
  | "THRESHOLD_INVALID"
  | "THRESHOLD_FORBIDDEN"
  | "PARTICIPANTS_EMPTY"
  | "PARTICIPANT_NOT_OBJECT"
  | "PARTICIPANT_FIELDS_INVALID"
  | "PARTICIPANT_TYPE_INVALID"
  | "PARTICIPANT_TYPE_UNSUPPORTED_IN_PILOT"
  | "PARTICIPANT_ID_INVALID"
  | "PARTICIPANT_NOT_ACTIVE"
  | "DUPLICATE_PARTICIPANT"
  | "PILOT_STAGE_PARTICIPANT_COUNT"
  | "BODY_RESOLUTION_PARTICIPANT_INVALID"
  | "GOVERNANCE_BODY_RULE_INVALID"
  | "SEPARATION_OF_DUTIES_UNSUPPORTED_IN_PILOT"
  | "MANDATE_NOT_OBJECT"
  | "MANDATE_EMPTY"
  | "UNKNOWN_MATERIALITY"
  | "MANDATE_ENTRY_INVALID"
  | "MANDATE_REQUIRES_EMPTY"
  | "MANDATE_DUPLICATE_PARTICIPANT";

export class WorkflowTemplateValidationError extends TypeError {
  constructor(
    readonly code: WorkflowTemplateValidationCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "WorkflowTemplateValidationError";
  }
}

export interface UnmetMandateRequirement {
  readonly materiality: MaterialityClass;
  readonly participant: WorkflowParticipant;
}

export class WorkflowMandateUnsatisfiedError extends Error {
  constructor(
    readonly documentTypeId: string,
    readonly unmet: UnmetMandateRequirement,
  ) {
    super(
      `document type ${documentTypeId} ${unmet.materiality} mandate requires ` +
        `${unmet.participant.type}:${unmet.participant.id}`,
    );
    this.name = "WorkflowMandateUnsatisfiedError";
  }
}

export class WorkflowConfigurationNotFoundError extends Error {
  constructor() {
    super("workflow template or document type not found");
    this.name = "WorkflowConfigurationNotFoundError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const materialities = new Set<string>(MATERIALITY_CLASSES);
const participantTypes = new Set<string>(WORKFLOW_PARTICIPANT_TYPES);
const completionRules = new Set<string>(WORKFLOW_COMPLETION_RULES);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsAreExactly(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function participantKey(participant: WorkflowParticipant): string {
  return `${participant.type}:${participant.id.toLowerCase()}`;
}

function parseParticipant(
  value: unknown,
  path: string,
  active: ActiveWorkflowParticipants,
): WorkflowParticipant {
  if (!record(value)) {
    throw new WorkflowTemplateValidationError("PARTICIPANT_NOT_OBJECT", path, "must be an object");
  }
  if (!fieldsAreExactly(value, ["id", "type"])) {
    throw new WorkflowTemplateValidationError(
      "PARTICIPANT_FIELDS_INVALID",
      path,
      "must contain exactly type and id",
    );
  }
  if (typeof value.type !== "string" || !participantTypes.has(value.type)) {
    throw new WorkflowTemplateValidationError(
      "PARTICIPANT_TYPE_INVALID",
      `${path}.type`,
      "is not a participant type",
    );
  }
  if (value.type === "ROLE_AT_SCOPE" || value.type === "GROUP") {
    throw new WorkflowTemplateValidationError(
      "PARTICIPANT_TYPE_UNSUPPORTED_IN_PILOT",
      `${path}.type`,
      `${value.type} is not supported in the Pilot`,
    );
  }
  if (typeof value.id !== "string" || !UUID.test(value.id)) {
    throw new WorkflowTemplateValidationError(
      "PARTICIPANT_ID_INVALID",
      `${path}.id`,
      "must be a UUID",
    );
  }
  const participant: WorkflowParticipant = {
    type: value.type as WorkflowParticipantType,
    id: value.id,
  };
  const activeIds = participant.type === "USER" ? active.userIds : active.governanceBodyIds;
  if (![...activeIds].some((id) => id.toLowerCase() === participant.id.toLowerCase())) {
    throw new WorkflowTemplateValidationError(
      "PARTICIPANT_NOT_ACTIVE",
      path,
      `${participant.type}:${participant.id} does not name an active tenant participant`,
    );
  }
  return participant;
}

function parseParticipants(
  value: unknown,
  path: string,
  active: ActiveWorkflowParticipants,
  emptyCode: "PARTICIPANTS_EMPTY" | "MANDATE_REQUIRES_EMPTY",
  duplicateCode: "DUPLICATE_PARTICIPANT" | "MANDATE_DUPLICATE_PARTICIPANT",
): readonly WorkflowParticipant[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkflowTemplateValidationError(emptyCode, path, "must be a non-empty array");
  }
  const participants = value.map((participant, index) =>
    parseParticipant(participant, `${path}[${index}]`, active),
  );
  const seen = new Set<string>();
  for (const participant of participants) {
    const key = participantKey(participant);
    if (seen.has(key)) {
      throw new WorkflowTemplateValidationError(
        duplicateCode,
        path,
        `${participant.type}:${participant.id} appears more than once`,
      );
    }
    seen.add(key);
  }
  return participants;
}

/** Parse the complete stored stage shape while enforcing the deliberately smaller Pilot subset. */
export function parseWorkflowStages(
  value: unknown,
  active: ActiveWorkflowParticipants,
): readonly WorkflowStage[] {
  if (!Array.isArray(value)) {
    throw new WorkflowTemplateValidationError("STAGES_NOT_ARRAY", "stages", "must be an array");
  }
  if (value.length === 0) {
    throw new WorkflowTemplateValidationError("STAGES_EMPTY", "stages", "must not be empty");
  }

  return value.map((candidate, index) => {
    const path = `stages[${index}]`;
    if (!record(candidate)) {
      throw new WorkflowTemplateValidationError("STAGE_NOT_OBJECT", path, "must be an object");
    }
    const thresholdPresent = Object.hasOwn(candidate, "threshold");
    const expectedFields = thresholdPresent
      ? ["completionRule", "name", "order", "participants", "threshold"]
      : ["completionRule", "name", "order", "participants"];
    if (!fieldsAreExactly(candidate, expectedFields)) {
      throw new WorkflowTemplateValidationError(
        "STAGE_FIELDS_INVALID",
        path,
        "contains unknown or missing fields",
      );
    }
    if (!Number.isInteger(candidate.order) || candidate.order !== index + 1) {
      throw new WorkflowTemplateValidationError(
        "STAGE_ORDER_INVALID",
        `${path}.order`,
        `must be ${index + 1}`,
      );
    }
    if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
      throw new WorkflowTemplateValidationError(
        "STAGE_NAME_REQUIRED",
        `${path}.name`,
        "is required",
      );
    }
    if (
      typeof candidate.completionRule !== "string" ||
      !completionRules.has(candidate.completionRule)
    ) {
      throw new WorkflowTemplateValidationError(
        "COMPLETION_RULE_INVALID",
        `${path}.completionRule`,
        "is not a completion rule",
      );
    }
    const participants = parseParticipants(
      candidate.participants,
      `${path}.participants`,
      active,
      "PARTICIPANTS_EMPTY",
      "DUPLICATE_PARTICIPANT",
    );
    const completionRule = candidate.completionRule as WorkflowCompletionRule;
    let threshold: number | undefined;
    if (completionRule === "AT_LEAST_N") {
      if (
        !Number.isInteger(candidate.threshold) ||
        (candidate.threshold as number) <= 1 ||
        (candidate.threshold as number) > participants.length
      ) {
        throw new WorkflowTemplateValidationError(
          "THRESHOLD_INVALID",
          `${path}.threshold`,
          "must be an integer above one and no greater than the participant count",
        );
      }
      threshold = candidate.threshold as number;
    } else if (thresholdPresent) {
      throw new WorkflowTemplateValidationError(
        "THRESHOLD_FORBIDDEN",
        `${path}.threshold`,
        "is allowed only for AT_LEAST_N",
      );
    }

    const bodies = participants.filter((participant) => participant.type === "GOVERNANCE_BODY");
    if (
      completionRule === "BODY_RESOLUTION" &&
      (participants.length !== 1 || bodies.length !== 1)
    ) {
      throw new WorkflowTemplateValidationError(
        "BODY_RESOLUTION_PARTICIPANT_INVALID",
        `${path}.participants`,
        "BODY_RESOLUTION requires exactly one governance body",
      );
    }
    if (completionRule !== "BODY_RESOLUTION" && bodies.length > 0) {
      throw new WorkflowTemplateValidationError(
        "GOVERNANCE_BODY_RULE_INVALID",
        `${path}.participants`,
        "a governance body requires BODY_RESOLUTION",
      );
    }
    if (completionRule === "ANY_ONE" || completionRule === "AT_LEAST_N") {
      throw new WorkflowTemplateValidationError(
        "COMPLETION_RULE_UNSUPPORTED_IN_PILOT",
        `${path}.completionRule`,
        `${completionRule} is not supported in the Pilot`,
      );
    }
    if (participants.length !== 1) {
      throw new WorkflowTemplateValidationError(
        "PILOT_STAGE_PARTICIPANT_COUNT",
        `${path}.participants`,
        "Pilot stages require exactly one participant",
      );
    }

    return Object.freeze({
      order: candidate.order as number,
      name: candidate.name.trim(),
      completionRule,
      ...(threshold === undefined ? {} : { threshold }),
      participants: Object.freeze(participants),
    });
  });
}

/** Pilot templates store the V1 field, but its only accepted value is the empty list. */
export function parseSeparationOfDutiesRules(value: unknown): readonly never[] {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new WorkflowTemplateValidationError(
      "SEPARATION_OF_DUTIES_UNSUPPORTED_IN_PILOT",
      "separationOfDutiesRules",
      "must be an empty array in the Pilot",
    );
  }
  return Object.freeze([]);
}

/** Parse the tenant's materiality-indexed minimum authority without permitting an empty floor. */
export function parseMandatedAuthority(
  value: unknown,
  active: ActiveWorkflowParticipants,
): MandatedAuthority {
  if (!record(value)) {
    throw new WorkflowTemplateValidationError(
      "MANDATE_NOT_OBJECT",
      "mandatedAuthority",
      "must be an object",
    );
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new WorkflowTemplateValidationError(
      "MANDATE_EMPTY",
      "mandatedAuthority",
      "must state at least one materiality class",
    );
  }
  const parsed: Partial<
    Record<MaterialityClass, Readonly<{ requires: readonly WorkflowParticipant[] }>>
  > = {};
  for (const key of keys) {
    if (!materialities.has(key)) {
      throw new WorkflowTemplateValidationError(
        "UNKNOWN_MATERIALITY",
        `mandatedAuthority.${key}`,
        "is not a materiality class",
      );
    }
    const entry = value[key];
    if (!record(entry) || !fieldsAreExactly(entry, ["requires"])) {
      throw new WorkflowTemplateValidationError(
        "MANDATE_ENTRY_INVALID",
        `mandatedAuthority.${key}`,
        "must contain exactly requires",
      );
    }
    parsed[key as MaterialityClass] = Object.freeze({
      requires: Object.freeze(
        parseParticipants(
          entry.requires,
          `mandatedAuthority.${key}.requires`,
          active,
          "MANDATE_REQUIRES_EMPTY",
          "MANDATE_DUPLICATE_PARTICIPANT",
        ),
      ),
    });
  }
  return Object.freeze(parsed);
}

export function effectiveMandateRequirements(
  mandate: MandatedAuthority,
  materiality: MaterialityClass,
): readonly WorkflowParticipant[] {
  const stated = mandate[materiality];
  if (stated) return stated.requires;
  const union = new Map<string, WorkflowParticipant>();
  for (const key of MATERIALITY_CLASSES) {
    for (const participant of mandate[key]?.requires ?? []) {
      union.set(participantKey(participant), participant);
    }
  }
  return Object.freeze([...union.values()]);
}

function stageBindsParticipant(stage: WorkflowStage, required: WorkflowParticipant): boolean {
  const namesRequired = stage.participants.some(
    (participant) => participantKey(participant) === participantKey(required),
  );
  if (!namesRequired) return false;
  if (stage.completionRule === "ALL" || stage.completionRule === "BODY_RESOLUTION") return true;
  return stage.completionRule === "AT_LEAST_N" && stage.threshold === stage.participants.length;
}

/** Return the first effective requirement that no stage makes indispensable. */
export function findUnmetMandateRequirement(
  stages: readonly WorkflowStage[],
  mandate: MandatedAuthority,
  materiality: MaterialityClass,
): UnmetMandateRequirement | undefined {
  const participant = effectiveMandateRequirements(mandate, materiality).find(
    (requirement) => !stages.some((stage) => stageBindsParticipant(stage, requirement)),
  );
  return participant ? { materiality, participant } : undefined;
}

interface DocumentTypeMandateRow extends Record<string, unknown> {
  id: string;
  mandated_authority: unknown;
}

interface ActiveParticipantRow extends Record<string, unknown> {
  participant_type: "USER" | "GOVERNANCE_BODY";
  id: string;
}

function collectParticipantIds(values: readonly unknown[]): {
  userIds: string[];
  governanceBodyIds: string[];
} {
  const users = new Set<string>();
  const bodies = new Set<string>();
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
      if (candidate.type === "USER") users.add(candidate.id);
      if (candidate.type === "GOVERNANCE_BODY") bodies.add(candidate.id);
    }
    for (const item of Object.values(candidate)) visit(item);
  };
  for (const value of values) visit(value);
  return { userIds: [...users], governanceBodyIds: [...bodies] };
}

async function loadActiveParticipants(
  transaction: AuditTransaction,
  tenantId: string,
  values: readonly unknown[],
): Promise<ActiveWorkflowParticipants> {
  const candidates = collectParticipantIds(values);
  const { rows } = await transaction.query<ActiveParticipantRow>(
    `select 'USER'::text as participant_type, id
       from app_user
      where tenant_id = $3::uuid and status = 'ACTIVE' and id = any($1::uuid[])
     union all
     select 'GOVERNANCE_BODY'::text as participant_type, id
       from governance_body
      where tenant_id = $3::uuid and status = 'ACTIVE' and id = any($2::uuid[])`,
    [candidates.userIds, candidates.governanceBodyIds, tenantId],
  );
  return {
    userIds: new Set(rows.filter((row) => row.participant_type === "USER").map((row) => row.id)),
    governanceBodyIds: new Set(
      rows.filter((row) => row.participant_type === "GOVERNANCE_BODY").map((row) => row.id),
    ),
  };
}

function assertAllMaterialitiesSatisfied(
  documentTypeId: string,
  stages: readonly WorkflowStage[],
  mandate: MandatedAuthority,
): void {
  for (const materiality of MATERIALITY_CLASSES) {
    const unmet = findUnmetMandateRequirement(stages, mandate, materiality);
    if (unmet) throw new WorkflowMandateUnsatisfiedError(documentTypeId, unmet);
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be positive`);
}

export interface PublishWorkflowTemplateVersionInput {
  readonly tenantId: string;
  readonly workflowTemplateId: string;
  readonly workflowTemplateVersionId: string;
  readonly versionSequence: number;
  readonly stages: unknown;
  readonly separationOfDutiesRules: unknown;
  readonly publishedAt: Date;
  readonly publishedBy: string;
}

export interface PublishedWorkflowTemplateVersion {
  readonly id: string;
  readonly workflowTemplateId: string;
  readonly versionSequence: number;
  readonly publishedAt: Date;
  readonly publishedBy: string;
  readonly templateRowVersion: number;
}

/** Publish an immutable version only after every currently-bound active type passes its floor. */
export async function publishWorkflowTemplateVersion(
  transaction: AuditTransaction,
  input: PublishWorkflowTemplateVersionInput,
): Promise<PublishedWorkflowTemplateVersion> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.workflowTemplateId, "workflowTemplateId");
  requireUuid(input.workflowTemplateVersionId, "workflowTemplateVersionId");
  requireUuid(input.publishedBy, "publishedBy");
  requirePositiveInteger(input.versionSequence, "versionSequence");
  if (!(input.publishedAt instanceof Date) || Number.isNaN(input.publishedAt.valueOf())) {
    throw new TypeError("publishedAt must be a valid Date");
  }

  const template = await transaction.query<{ id: string }>(
    `select id
       from workflow_template
      where id = $1::uuid and tenant_id = $2::uuid and status = 'ACTIVE'
      for update`,
    [input.workflowTemplateId, input.tenantId],
  );
  if (template.rows.length !== 1) throw new WorkflowConfigurationNotFoundError();

  const documentTypes = await transaction.query<DocumentTypeMandateRow>(
    `select id, mandated_authority
      from document_type
      where status = 'ACTIVE'
        and default_workflow_template_id = $1::uuid
        and tenant_id = $2::uuid
      order by id`,
    [input.workflowTemplateId, input.tenantId],
  );
  const active = await loadActiveParticipants(transaction, input.tenantId, [
    input.stages,
    ...documentTypes.rows.map((row) => row.mandated_authority),
  ]);
  const stages = parseWorkflowStages(input.stages, active);
  const separationRules = parseSeparationOfDutiesRules(input.separationOfDutiesRules);
  for (const documentType of documentTypes.rows) {
    const mandate = parseMandatedAuthority(documentType.mandated_authority, active);
    assertAllMaterialitiesSatisfied(documentType.id, stages, mandate);
  }

  const { rows } = await transaction.query<
    PublishedWorkflowTemplateVersion & Record<string, unknown>
  >(
    `with inserted as (
       insert into workflow_template_version (
         tenant_id, id, workflow_template_id, version_sequence, stages,
         separation_of_duties_rules, published_at, published_by
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb,
                 $6::jsonb, $7::timestamptz, $8::uuid)
       returning id, workflow_template_id, version_sequence, published_at, published_by
     ), activated as (
       update workflow_template template
          set active_version_id = inserted.id,
              updated_at = $7::timestamptz,
              row_version = template.row_version + 1
         from inserted
        where template.tenant_id = $1::uuid
          and template.id = inserted.workflow_template_id
          and template.status = 'ACTIVE'
       returning template.row_version
     )
     select inserted.id,
            inserted.workflow_template_id as "workflowTemplateId",
            inserted.version_sequence as "versionSequence",
            inserted.published_at as "publishedAt",
            inserted.published_by as "publishedBy",
            activated.row_version as "templateRowVersion"
       from inserted cross join activated`,
    [
      input.tenantId,
      input.workflowTemplateVersionId,
      input.workflowTemplateId,
      input.versionSequence,
      JSON.stringify(stages),
      JSON.stringify(separationRules),
      input.publishedAt.toISOString(),
      input.publishedBy,
    ],
  );
  const published = rows[0];
  if (!published || rows.length !== 1) throw new WorkflowConfigurationNotFoundError();
  return published;
}

export interface AssignWorkflowTemplateInput {
  readonly tenantId: string;
  readonly documentTypeId: string;
  readonly workflowTemplateId: string;
  readonly expectedRowVersion: number;
  readonly changedAt: Date;
}

export interface AssignedWorkflowTemplate {
  readonly documentTypeId: string;
  readonly workflowTemplateId: string;
  readonly rowVersion: number;
}

interface AssignmentCandidateRow extends DocumentTypeMandateRow {
  stages: unknown;
}

/** Bind a type only to a published active version that satisfies every materiality floor. */
export async function assignWorkflowTemplateToDocumentType(
  transaction: AuditTransaction,
  input: AssignWorkflowTemplateInput,
): Promise<AssignedWorkflowTemplate> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.documentTypeId, "documentTypeId");
  requireUuid(input.workflowTemplateId, "workflowTemplateId");
  requirePositiveInteger(input.expectedRowVersion, "expectedRowVersion");
  if (!(input.changedAt instanceof Date) || Number.isNaN(input.changedAt.valueOf())) {
    throw new TypeError("changedAt must be a valid Date");
  }

  // Use the same first lock as publication. An assignment must validate the version that
  // remains active when its document-type update commits, and publication must see every
  // assignment that commits before it chooses a new active version.
  const template = await transaction.query<{ id: string }>(
    `select id
       from workflow_template
      where id = $1::uuid and tenant_id = $2::uuid and status = 'ACTIVE'
      for update`,
    [input.workflowTemplateId, input.tenantId],
  );
  if (template.rows.length !== 1) throw new WorkflowConfigurationNotFoundError();

  const candidate = await transaction.query<AssignmentCandidateRow>(
    `select document_type.id, document_type.mandated_authority, version.stages
       from document_type
       join workflow_template template
         on template.tenant_id = document_type.tenant_id
        and template.id = $2::uuid
        and template.status = 'ACTIVE'
       join workflow_template_version version
         on version.tenant_id = template.tenant_id
        and version.id = template.active_version_id
        and version.workflow_template_id = template.id
      where document_type.id = $1::uuid
        and document_type.tenant_id = $3::uuid
        and document_type.status = 'ACTIVE'
      for update of document_type`,
    [input.documentTypeId, input.workflowTemplateId, input.tenantId],
  );
  const row = candidate.rows[0];
  if (!row || candidate.rows.length !== 1) throw new WorkflowConfigurationNotFoundError();
  const active = await loadActiveParticipants(transaction, input.tenantId, [
    row.stages,
    row.mandated_authority,
  ]);
  const stages = parseWorkflowStages(row.stages, active);
  const mandate = parseMandatedAuthority(row.mandated_authority, active);
  assertAllMaterialitiesSatisfied(row.id, stages, mandate);

  const updated = await transaction.query<
    { documentTypeId: string; workflowTemplateId: string; rowVersion: number } & Record<
      string,
      unknown
    >
  >(
    `update document_type
        set default_workflow_template_id = $2::uuid,
            updated_at = $4::timestamptz,
            row_version = row_version + 1
      where id = $1::uuid and row_version = $3::integer and tenant_id = $5::uuid
      returning id as "documentTypeId",
                default_workflow_template_id as "workflowTemplateId",
                row_version as "rowVersion"`,
    [
      input.documentTypeId,
      input.workflowTemplateId,
      input.expectedRowVersion,
      input.changedAt.toISOString(),
      input.tenantId,
    ],
  );
  const assignment = updated.rows[0];
  if (!assignment || updated.rows.length !== 1) throw new WorkflowConfigurationNotFoundError();
  return assignment;
}
