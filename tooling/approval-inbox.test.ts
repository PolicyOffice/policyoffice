import { describe, expect, it } from "vitest";
import {
  AuthzContext,
  listApprovalInbox,
  type AuditTransaction,
  type AuthorizationFacts,
} from "../packages/domain/src/index.js";

const TENANT = "c4000000-0000-0000-0000-000000000001";
const USER = "c4000000-0000-0000-0001-000000000001";
const OTHER_USER = "c4000000-0000-0000-0001-000000000002";
const BODY = "c4000000-0000-0000-0010-000000000001";
const RUN = "c4000000-0000-0000-0032-000000000001";
const REVISION = "c4000000-0000-0000-0031-000000000001";
const DIGEST = `sha-256:${"a".repeat(64)}`;
const INSTANT = new Date("2026-09-20T09:00:00.000Z");

function workRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    task_id: "c4000000-0000-0000-0034-000000000001",
    task_status: "PENDING",
    participant_type: "USER",
    participant_id: USER,
    participant_name: "Approver One",
    assigned_at: INSTANT,
    task_due_at: null,
    document_id: "c4000000-0000-0000-0018-000000000001",
    document_code: "POL-034",
    document_title: "Approval inbox policy",
    version_id: "c4000000-0000-0000-0030-000000000001",
    display_label: "1.0",
    materiality: "MATERIAL",
    change_summary: "A governed change",
    revision_id: REVISION,
    content_digest: DIGEST,
    submitted_at: INSTANT,
    org_unit_id: "c4000000-0000-0000-0007-000000000001",
    org_unit_code: "COMPLIANCE",
    org_unit_name: "Compliance",
    stage_id: "c4000000-0000-0000-0033-000000000001",
    stage_order: 2,
    completion_rule: "ALL",
    threshold: null,
    stage_status: "IN_PROGRESS",
    stage_due_at: null,
    run_id: RUN,
    run_status: "RUNNING",
    run_started_at: INSTANT,
    ...overrides,
  };
}

function decisionRow() {
  return {
    run_id: RUN,
    decision_id: "c4000000-0000-0000-0035-000000000001",
    decision: "APPROVE",
    decided_by_type: "USER",
    decided_by_id: OTHER_USER,
    decided_by_name: "Earlier Approver",
    recorded_by_user_id: OTHER_USER,
    recorded_by_name: "Earlier Approver",
    recorded_at: INSTANT,
    content_revision_id: REVISION,
    content_digest: DIGEST,
    reason_code: null,
    resolution_reference: null,
    resolution_date: null,
    minutes_attachment_id: null,
    attending_members: null,
  };
}

function transaction(
  work: readonly Readonly<Record<string, unknown>>[],
  decisions: readonly Readonly<Record<string, unknown>>[],
  applicability: readonly Readonly<Record<string, unknown>>[] = [],
): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string) {
      const rows = text.includes("from approval_decision decision")
        ? decisions
        : text.includes("from applicability_rule rule")
          ? applicability
          : work;
      return { rows: rows as Row[] };
    },
  };
}

function context(load: () => Promise<AuthorizationFacts>): AuthzContext {
  return new AuthzContext({
    tenantId: TENANT,
    principal: { type: "USER", id: USER },
    instant: INSTANT,
    load,
  });
}

describe("approval inbox read-model shaping", () => {
  it("INV-APR-001: keeps the exact submitted revision, digest and prior decisions together", async () => {
    const items = await listApprovalInbox(
      transaction(
        [workRow(), workRow({ task_id: OTHER_USER, participant_id: OTHER_USER })],
        [decisionRow()],
        [
          {
            version_id: "c4000000-0000-0000-0030-000000000001",
            rule_id: "c4000000-0000-0000-0023-000000000001",
            effect: "INCLUDE",
            inheritance_mode: "MANDATORY",
            legal_entities: [],
            org_units: [
              {
                id: "c4000000-0000-0000-0007-000000000001",
                name: "Compliance (COMPLIANCE)",
              },
            ],
            jurisdictions: [],
            groups: [],
            users: [],
            valid_from: INSTANT,
            valid_until: null,
          },
        ],
      ),
      context(async () => {
        throw new Error("user-task ownership must not need an authorization load");
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      task: { participant: { type: "USER", id: USER, name: "Approver One" } },
      document: { code: "POL-034", title: "Approval inbox policy" },
      version: { displayLabel: "1.0", materiality: "MATERIAL" },
      revision: { id: REVISION, digest: DIGEST, submittedAt: INSTANT },
      scope: {
        orgUnitCode: "COMPLIANCE",
        orgUnitName: "Compliance",
        applicabilityRules: [
          {
            effect: "INCLUDE",
            inheritanceMode: "MANDATORY",
            orgUnits: [
              {
                id: "c4000000-0000-0000-0007-000000000001",
                name: "Compliance (COMPLIANCE)",
              },
            ],
          },
        ],
      },
      stage: { order: 2, completionRule: "ALL" },
      run: { id: RUN, status: "RUNNING" },
      priorDecisions: [
        {
          decision: "APPROVE",
          decidedBy: { type: "USER", id: OTHER_USER, name: "Earlier Approver" },
          recordedBy: { id: OTHER_USER, name: "Earlier Approver" },
          contentRevisionId: REVISION,
          contentDigest: DIGEST,
        },
      ],
    });
  });

  it("INV-APR-021: includes a body task only when the principal can represent that exact body", async () => {
    const bodyTask = workRow({
      participant_type: "GOVERNANCE_BODY",
      participant_id: BODY,
      participant_name: "Management Board",
      completion_rule: "BODY_RESOLUTION",
    });
    const allowed = await listApprovalInbox(
      transaction([bodyTask], []),
      context(async () => ({
        resourceFound: true,
        principalActive: true,
        resourceScopes: [{ type: "GOVERNANCE_BODY", id: BODY }],
        grants: [
          {
            ref: { tenantId: TENANT, id: "c4000000-0000-0000-0025-000000000001" },
            effect: "ALLOW",
            capabilities: ["body.act_for"],
            scope: { type: "GOVERNANCE_BODY", id: BODY },
            validity: {
              from: null,
              fromInclusive: true,
              until: null,
              untilInclusive: false,
              empty: false,
            },
          },
        ],
      })),
    );
    const denied = await listApprovalInbox(
      transaction([bodyTask], []),
      context(async () => ({
        resourceFound: true,
        principalActive: true,
        resourceScopes: [{ type: "GOVERNANCE_BODY", id: BODY }],
        grants: [],
      })),
    );

    expect(allowed[0]?.task.participant).toEqual({
      type: "GOVERNANCE_BODY",
      id: BODY,
      name: "Management Board",
    });
    expect(denied).toEqual([]);
  });
});
