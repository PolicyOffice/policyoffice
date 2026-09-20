import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApprovalCandidateHandler,
  createApprovalDecisionHandler,
  createApprovalInboxHandler,
} from "../../../apps/web/src/approval-inbox.js";
import { issueSession } from "../../domain/src/index.js";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the approval-inbox fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const FIXTURE_USER = tenantA.users[0]?.id ?? "";
const DOCUMENT = tenantA.documents[0]?.id ?? "";
const BASELINE_VARIANT = tenantA.documents[0]?.baselineVariantId ?? "";
const DOCUMENT_TYPE = tenantA.documents[0]?.documentTypeId ?? "";
const CLASSIFICATION = tenantA.classifications[0]?.id ?? "";
const WORKFLOW_VERSION = tenantA.workflowTemplate.versionId;
const CONFIGURATION = tenantA.configuration.id;
const BODY = tenantA.governanceBody.id;
const BODY_NAME = tenantA.governanceBody.name;
const FIXTURE_USER_NAME = tenantA.users[0]?.displayName ?? "Fixture administrator";
const ORG_UNIT = tenantA.orgUnit.id;
const FOREIGN_TASK = tenantB.documents[0]?.approvalBodyTaskId ?? "";

const APPROVER = id(1, 1);
const NO_CAPABILITY = id(1, 2);
const OTHER_USER = id(1, 3);
const BODY_RECORDER = id(1, 4);
const WRONG_BODY_RECORDER = id(1, 5);
const SECOND_BODY = id(10, 2);

const APPROVE = approvalFixture(1, APPROVER, "USER", { priorDecision: true });
const OTHER = approvalFixture(2, OTHER_USER, "USER");
const NO_CAP = approvalFixture(3, NO_CAPABILITY, "USER");
const BODY_APPROVAL = approvalFixture(4, BODY, "GOVERNANCE_BODY");
const WRONG_BODY_APPROVAL = approvalFixture(5, BODY, "GOVERNANCE_BODY");
const BLOCKED = approvalFixture(6, APPROVER, "USER", { blocked: true });
const CHANGES = approvalFixture(7, APPROVER, "USER");
const REJECTION = approvalFixture(8, APPROVER, "USER");

const REQUEST_INSTANT = new Date("2026-09-20T09:00:00.000Z");
const SESSION_INSTANT = new Date("2026-09-20T08:55:00.000Z");
const SUBMITTED_AT = new Date("2026-09-19T08:00:00.000Z");
const tokens = new Map<string, string>();

interface ApprovalFixture {
  readonly ordinal: number;
  readonly variantId: string;
  readonly versionId: string;
  readonly revisionId: string;
  readonly applicabilityRuleId: string;
  readonly runId: string;
  readonly currentStageId: string;
  readonly currentTaskId: string;
  readonly priorStageId: string | null;
  readonly priorTaskId: string | null;
  readonly priorDecisionId: string | null;
  readonly participantId: string;
  readonly participantType: "USER" | "GOVERNANCE_BODY";
  readonly blocked: boolean;
  readonly digest: string;
}

function id(namespace: number, ordinal: number): string {
  return `c5000000-0000-0000-${String(namespace).padStart(4, "0")}-${String(ordinal).padStart(12, "0")}`;
}

function approvalFixture(
  ordinal: number,
  participantId: string,
  participantType: ApprovalFixture["participantType"],
  options: Readonly<{ priorDecision?: boolean; blocked?: boolean }> = {},
): ApprovalFixture {
  const priorDecision = options.priorDecision ?? false;
  return {
    ordinal,
    variantId: id(40, ordinal),
    versionId: id(41, ordinal),
    revisionId: id(42, ordinal),
    applicabilityRuleId: id(47, ordinal),
    runId: id(43, ordinal),
    currentStageId: id(44, ordinal * 10 + (priorDecision ? 2 : 1)),
    currentTaskId: id(45, ordinal * 10 + (priorDecision ? 2 : 1)),
    priorStageId: priorDecision ? id(44, ordinal * 10 + 1) : null,
    priorTaskId: priorDecision ? id(45, ordinal * 10 + 1) : null,
    priorDecisionId: priorDecision ? id(46, ordinal) : null,
    participantId,
    participantType,
    blocked: options.blocked ?? false,
    digest: `sha-256:${ordinal.toString(16).repeat(64)}`,
  };
}

async function asPrincipal<T>(
  principalId: string,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(
    { tenantId: TENANT_A, principal: { type: "USER", id: principalId } },
    fn,
  );
}

async function sessionFor(userId: string): Promise<string> {
  const session = await asPrincipal(userId, (transaction) =>
    issueSession(transaction, {
      tenantId: TENANT_A,
      userId,
      userAgentClass: "POL-034 approval-inbox integration test",
      instant: SESSION_INSTANT,
    }),
  );
  return session.token;
}

function token(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`missing token for ${userId}`);
  return value;
}

function ids(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id factory exhausted");
    index += 1;
    return value;
  };
}

async function insertCandidate(
  transaction: ApplicationTransaction,
  candidate: ApprovalFixture,
): Promise<void> {
  const currentOrder = candidate.priorDecisionId ? 2 : 1;
  const participantName =
    candidate.participantType === "GOVERNANCE_BODY"
      ? BODY_NAME
      : candidate.participantId === APPROVER
        ? "Approval Inbox Approver"
        : candidate.participantId === NO_CAPABILITY
          ? "Approval Inbox No Capability"
          : "Approval Inbox Other User";
  const snapshot = [
    ...(candidate.priorDecisionId
      ? [
          {
            order: 1,
            participants: [
              {
                type: "USER",
                id: FIXTURE_USER,
                displayName: FIXTURE_USER_NAME,
              },
            ],
          },
        ]
      : []),
    {
      order: currentOrder,
      participants: [
        {
          type: candidate.participantType,
          id: candidate.participantId,
          displayName: participantName,
        },
      ],
    },
  ];

  await transaction.query(
    `insert into document_variant (
       tenant_id, id, document_id, variant_type, source_variant_id, locale, status
     ) values ($1, $2, $3, 'SUPPLEMENT', $4, null, 'ACTIVE')`,
    [TENANT_A, candidate.variantId, DOCUMENT, BASELINE_VARIANT],
  );
  await transaction.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id, materiality,
       change_summary, configuration_version_id
     ) values (
       $1, $2, $3, 1, $4, 'DRAFT', $5, $6, $7, 'MATERIAL', $8, $9
     )`,
    [
      TENANT_A,
      candidate.versionId,
      candidate.variantId,
      `inbox-${candidate.ordinal}`,
      DOCUMENT_TYPE,
      `Approval inbox candidate ${candidate.ordinal}`,
      CLASSIFICATION,
      `Approval inbox change ${candidate.ordinal}`,
      CONFIGURATION,
    ],
  );
  await transaction.query(
    `insert into content_revision (
       tenant_id, id, document_version_id, revision_sequence, content_ref,
       canonical_manifest, canonicalisation_schema_version, content_digest,
       created_by, submitted_at
     ) values ($1, $2, $3, 1, null, $4::jsonb, 1, $5, $6, $7)`,
    [
      TENANT_A,
      candidate.revisionId,
      candidate.versionId,
      JSON.stringify(`approval-inbox-manifest-${candidate.ordinal}`),
      candidate.digest,
      OTHER_USER,
      SUBMITTED_AT.toISOString(),
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
      TENANT_A,
      candidate.applicabilityRuleId,
      candidate.variantId,
      candidate.versionId,
      [ORG_UNIT],
      fixture.createdAt,
    ],
  );
  await transaction.query(
    `update document_version
        set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
      where tenant_id = $1 and id = $2 and lifecycle_state = 'DRAFT'`,
    [TENANT_A, candidate.versionId],
  );
  await transaction.query(
    `insert into approval_run (
       tenant_id, id, content_revision_id, workflow_template_version_id,
       resolved_participants, status, started_at, configuration_version_id
     ) values ($1, $2, $3, $4, $5::jsonb, $6::run_status, $7, $8)`,
    [
      TENANT_A,
      candidate.runId,
      candidate.revisionId,
      WORKFLOW_VERSION,
      JSON.stringify(snapshot),
      candidate.blocked ? "BLOCKED" : "RUNNING",
      SUBMITTED_AT.toISOString(),
      CONFIGURATION,
    ],
  );

  if (candidate.priorStageId && candidate.priorTaskId && candidate.priorDecisionId) {
    await transaction.query(
      `insert into approval_stage (
         tenant_id, id, approval_run_id, stage_order, completion_rule, status, completed_at
       ) values ($1, $2, $3, 1, 'ALL', 'COMPLETED', $4)`,
      [TENANT_A, candidate.priorStageId, candidate.runId, SUBMITTED_AT.toISOString()],
    );
    await transaction.query(
      `insert into approval_task (
         tenant_id, id, approval_stage_id, participant_type, participant_id,
         status, assigned_at
       ) values ($1, $2, $3, 'USER', $4, 'DECIDED', $5)`,
      [
        TENANT_A,
        candidate.priorTaskId,
        candidate.priorStageId,
        FIXTURE_USER,
        SUBMITTED_AT.toISOString(),
      ],
    );
    await transaction.query(
      `insert into approval_decision (
         tenant_id, id, approval_task_id, decision, decided_by_type, decided_by_id,
         recorded_by_user_id, recorded_at, content_revision_id, content_digest,
         configuration_version_id
       ) values ($1, $2, $3, 'APPROVE', 'USER', $4, $4, $5, $6, $7, $8)`,
      [
        TENANT_A,
        candidate.priorDecisionId,
        candidate.priorTaskId,
        FIXTURE_USER,
        SUBMITTED_AT.toISOString(),
        candidate.revisionId,
        candidate.digest,
        CONFIGURATION,
      ],
    );
  }

  await transaction.query(
    `insert into approval_stage (
       tenant_id, id, approval_run_id, stage_order, completion_rule, status
     ) values ($1, $2, $3, $4, $5::completion_rule, $6::approval_stage_status)`,
    [
      TENANT_A,
      candidate.currentStageId,
      candidate.runId,
      currentOrder,
      candidate.participantType === "GOVERNANCE_BODY" ? "BODY_RESOLUTION" : "ALL",
      candidate.blocked ? "BLOCKED" : "IN_PROGRESS",
    ],
  );
  await transaction.query(
    `insert into approval_task (
       tenant_id, id, approval_stage_id, participant_type, participant_id,
       status, assigned_at
     ) values ($1, $2, $3, $4::approval_participant_type, $5, 'PENDING', $6)`,
    [
      TENANT_A,
      candidate.currentTaskId,
      candidate.currentStageId,
      candidate.participantType,
      candidate.participantId,
      SUBMITTED_AT.toISOString(),
    ],
  );
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  await asPrincipal(FIXTURE_USER, async (transaction) => {
    await transaction.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values
         ($1, $2, 'Approval Inbox Approver', 'inbox-approver@example.test', 'ACTIVE'),
         ($1, $3, 'Approval Inbox No Capability', 'inbox-no-capability@example.test', 'ACTIVE'),
         ($1, $4, 'Approval Inbox Other User', 'inbox-other@example.test', 'ACTIVE'),
         ($1, $5, 'Approval Inbox Body Recorder', 'inbox-body@example.test', 'ACTIVE'),
         ($1, $6, 'Approval Inbox Wrong Body', 'inbox-wrong-body@example.test', 'ACTIVE')`,
      [TENANT_A, APPROVER, NO_CAPABILITY, OTHER_USER, BODY_RECORDER, WRONG_BODY_RECORDER],
    );
    await transaction.query(
      `insert into governance_body (
         tenant_id, id, code, name, legal_entity_id, quorum_rule, status
       ) values ($1, $2, 'RISK_COMMITTEE', 'Risk Committee', $3, '{"kind":"MAJORITY"}', 'ACTIVE')`,
      [TENANT_A, SECOND_BODY, tenantA.legalEntity.id],
    );
    await transaction.query(
      `insert into access_grant (
         tenant_id, id, effect, principal_type, principal_id, capability,
         scope_type, scope_id, validity, granted_by, reason
       ) values
         ($1, $2, 'ALLOW', 'USER', $3, 'document.approve', 'TENANT', null,
          tstzrange($4::timestamptz, null, '[)'), $5, 'POL-034 approver'),
         ($1, $6, 'ALLOW', 'USER', $7, 'body.act_for', 'GOVERNANCE_BODY', $8,
          tstzrange($4::timestamptz, null, '[)'), $5, 'POL-034 body recorder'),
         ($1, $9, 'ALLOW', 'USER', $10, 'body.act_for', 'GOVERNANCE_BODY', $11,
          tstzrange($4::timestamptz, null, '[)'), $5, 'POL-034 wrong body')`,
      [
        TENANT_A,
        id(25, 1),
        APPROVER,
        fixture.createdAt,
        FIXTURE_USER,
        id(25, 2),
        BODY_RECORDER,
        BODY,
        id(25, 3),
        WRONG_BODY_RECORDER,
        SECOND_BODY,
      ],
    );

    for (const candidate of [
      APPROVE,
      OTHER,
      NO_CAP,
      BODY_APPROVAL,
      WRONG_BODY_APPROVAL,
      BLOCKED,
      CHANGES,
      REJECTION,
    ]) {
      await insertCandidate(transaction, candidate);
    }
  });

  for (const userId of [APPROVER, NO_CAPABILITY, OTHER_USER, BODY_RECORDER, WRONG_BODY_RECORDER]) {
    tokens.set(userId, await sessionFor(userId));
  }
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("approval inbox request boundaries", () => {
  it("INV-APR-001 / INV-APR-021 / INV-TEN-001: lists only work owned by the principal or their exact body", async () => {
    const approverResponse = await createApprovalInboxHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(APPROVER) });
    const approverBody = (await approverResponse.json()) as {
      items: readonly {
        task: { id: string };
        scope: { applicabilityRules: readonly { id: string }[] };
        priorDecisions: readonly { id: string }[];
      }[];
    };
    const recorderResponse = await createApprovalInboxHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(BODY_RECORDER) });
    const recorderBody = (await recorderResponse.json()) as {
      items: readonly { task: { id: string; participant: { type: string; id: string } } }[];
    };

    expect(approverResponse.status).toBe(200);
    expect(approverBody.items.map(({ task }) => task.id)).toEqual(
      expect.arrayContaining([
        APPROVE.currentTaskId,
        BLOCKED.currentTaskId,
        CHANGES.currentTaskId,
        REJECTION.currentTaskId,
      ]),
    );
    expect(approverBody.items.map(({ task }) => task.id)).not.toEqual(
      expect.arrayContaining([
        OTHER.currentTaskId,
        NO_CAP.currentTaskId,
        BODY_APPROVAL.currentTaskId,
      ]),
    );
    expect(
      approverBody.items
        .find(({ task }) => task.id === APPROVE.currentTaskId)
        ?.priorDecisions.map(({ id }) => id),
    ).toEqual([APPROVE.priorDecisionId]);
    expect(
      approverBody.items
        .find(({ task }) => task.id === APPROVE.currentTaskId)
        ?.scope.applicabilityRules.map(({ id }) => id),
    ).toEqual([APPROVE.applicabilityRuleId]);
    expect(recorderBody.items.map(({ task }) => task.id)).toEqual(
      expect.arrayContaining([BODY_APPROVAL.currentTaskId, WRONG_BODY_APPROVAL.currentTaskId]),
    );
    expect(recorderBody.items[0]?.task.participant).toMatchObject({
      type: "GOVERNANCE_BODY",
      id: BODY,
    });
  });

  it("INV-TEN-002 / INV-TEN-005: makes absent and cross-tenant task identifiers identical", async () => {
    const handle = createApprovalCandidateHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const absent = await handle({ sessionToken: token(APPROVER), taskId: id(99, 1) });
    const crossTenant = await handle({ sessionToken: token(APPROVER), taskId: FOREIGN_TASK });

    expect(absent.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(await absent.text()).toBe('{"error":"not_found"}');
    expect(await crossTenant.text()).toBe('{"error":"not_found"}');
  });

  it("INV-AUTH-001: refuses an owned user task without document.approve and writes nothing", async () => {
    const detail = await createApprovalCandidateHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(NO_CAPABILITY), taskId: NO_CAP.currentTaskId });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ canDecide: false });

    const response = await createApprovalDecisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(id(90, 1), id(91, 1)),
    })({
      sessionToken: token(NO_CAPABILITY),
      taskId: NO_CAP.currentTaskId,
      decision: "APPROVE",
      reasonCode: null,
      resolutionReference: null,
      resolutionDate: null,
      minutesAttachmentId: null,
      attendingMembers: null,
    });
    expect(response.status).toBe(404);

    await asPrincipal(FIXTURE_USER, async (transaction) => {
      const decision = await transaction.query<{ count: string }>(
        "select count(*)::text as count from approval_decision where approval_task_id = $1",
        [NO_CAP.currentTaskId],
      );
      expect(decision.rows[0]?.count).toBe("0");
    });
  });

  it("INV-APR-023: a grant for a different body reveals no task and records no resolution", async () => {
    const detail = await createApprovalCandidateHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(WRONG_BODY_RECORDER), taskId: WRONG_BODY_APPROVAL.currentTaskId });
    const decision = await createApprovalDecisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(id(90, 2), id(91, 2)),
    })({
      sessionToken: token(WRONG_BODY_RECORDER),
      taskId: WRONG_BODY_APPROVAL.currentTaskId,
      decision: "APPROVE",
      reasonCode: null,
      resolutionReference: "RISK-99",
      resolutionDate: "2026-09-20",
      minutesAttachmentId: null,
      attendingMembers: null,
    });

    expect(detail.status).toBe(404);
    expect(decision.status).toBe(404);
    await asPrincipal(FIXTURE_USER, async (transaction) => {
      const result = await transaction.query<{ count: string }>(
        "select count(*)::text as count from approval_decision where approval_task_id = $1",
        [WRONG_BODY_APPROVAL.currentTaskId],
      );
      expect(result.rows[0]?.count).toBe("0");
    });
  });

  it("exposes a blocked run as an exception but accepts no decision", async () => {
    const detail = await createApprovalCandidateHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(APPROVER), taskId: BLOCKED.currentTaskId });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      item: { run: { status: "BLOCKED" }, stage: { status: "BLOCKED" } },
    });

    const decision = await createApprovalDecisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(id(90, 3), id(91, 3)),
    })({
      sessionToken: token(APPROVER),
      taskId: BLOCKED.currentTaskId,
      decision: "APPROVE",
      reasonCode: null,
      resolutionReference: null,
      resolutionDate: null,
      minutesAttachmentId: null,
      attendingMembers: null,
    });
    expect(decision.status).toBe(404);
  });

  it("INV-APR-001 / INV-APR-009: approves the exact user task and completes its run once", async () => {
    const response = await createApprovalDecisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(id(90, 4), id(91, 4)),
    })({
      sessionToken: token(APPROVER),
      taskId: APPROVE.currentTaskId,
      decision: "APPROVE",
      reasonCode: "APPROVED_AS_SUBMITTED",
      resolutionReference: null,
      resolutionDate: null,
      minutesAttachmentId: null,
      attendingMembers: null,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/approvals?recorded=APPROVE");
    await asPrincipal(FIXTURE_USER, async (transaction) => {
      const result = await transaction.query<{
        task_status: string;
        run_status: string;
        lifecycle_state: string;
        content_revision_id: string;
        content_digest: string;
      }>(
        `select task.status as task_status, run.status as run_status,
                version.lifecycle_state, decision.content_revision_id, decision.content_digest
           from approval_task task
           join approval_stage stage on stage.id = task.approval_stage_id
           join approval_run run on run.id = stage.approval_run_id
           join content_revision revision on revision.id = run.content_revision_id
           join document_version version on version.id = revision.document_version_id
           join approval_decision decision on decision.approval_task_id = task.id
          where task.id = $1`,
        [APPROVE.currentTaskId],
      );
      expect(result.rows).toEqual([
        {
          task_status: "DECIDED",
          run_status: "COMPLETED",
          lifecycle_state: "APPROVED",
          content_revision_id: APPROVE.revisionId,
          content_digest: APPROVE.digest,
        },
      ]);
    });
  });

  it.each([
    ["REQUEST_CHANGES", CHANGES, "CHANGES_REQUESTED"],
    ["REJECT", REJECTION, "REJECTED"],
  ] as const)(
    "INV-APR-003: %s terminates the run and preserves the decision",
    async (decision, candidate, expectedStatus) => {
      const response = await createApprovalDecisionHandler({
        tenantId: TENANT_A,
        clock: () => REQUEST_INSTANT,
        idFactory: ids(id(90, candidate.ordinal + 10), id(91, candidate.ordinal + 10)),
      })({
        sessionToken: token(APPROVER),
        taskId: candidate.currentTaskId,
        decision,
        reasonCode: `${decision}_REASON`,
        resolutionReference: null,
        resolutionDate: null,
        minutesAttachmentId: null,
        attendingMembers: null,
      });
      expect(response.status).toBe(303);

      await asPrincipal(FIXTURE_USER, async (transaction) => {
        const result = await transaction.query<{ run_status: string; lifecycle_state: string }>(
          `select run.status as run_status, version.lifecycle_state
             from approval_run run
             join content_revision revision on revision.id = run.content_revision_id
             join document_version version on version.id = revision.document_version_id
            where run.id = $1`,
          [candidate.runId],
        );
        expect(result.rows).toEqual([
          { run_status: expectedStatus, lifecycle_state: expectedStatus },
        ]);
      });
    },
  );

  it("INV-APR-021 / INV-APR-022 / INV-APR-023: records the body as authority and user as recorder", async () => {
    const response = await createApprovalDecisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(id(90, 20), id(91, 20)),
    })({
      sessionToken: token(BODY_RECORDER),
      taskId: BODY_APPROVAL.currentTaskId,
      decision: "APPROVE",
      reasonCode: "MINUTED_RESOLUTION",
      resolutionReference: "MB-2026-09-20-01",
      resolutionDate: "2026-09-20",
      minutesAttachmentId: null,
      attendingMembers: [FIXTURE_USER],
    });

    expect(response.status).toBe(303);
    await asPrincipal(FIXTURE_USER, async (transaction) => {
      const result = await transaction.query<{
        decided_by_type: string;
        decided_by_id: string;
        recorded_by_user_id: string;
        resolution_reference: string;
        resolution_date: string;
        attending_members: string[];
      }>(
        `select decided_by_type, decided_by_id, recorded_by_user_id,
                resolution_reference, resolution_date::text, attending_members
           from approval_decision
          where approval_task_id = $1`,
        [BODY_APPROVAL.currentTaskId],
      );
      expect(result.rows).toEqual([
        {
          decided_by_type: "BODY",
          decided_by_id: BODY,
          recorded_by_user_id: BODY_RECORDER,
          resolution_reference: "MB-2026-09-20-01",
          resolution_date: "2026-09-20",
          attending_members: [FIXTURE_USER],
        },
      ]);
    });
  });
});
