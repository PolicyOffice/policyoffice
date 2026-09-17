import { describe, expect, it } from "vitest";
import {
  WORKFLOW_TEMPLATE_REQUIRED_CAPABILITIES,
  WorkflowTemplateValidationError,
  effectiveMandateRequirements,
  findUnmetMandateRequirement,
  parseMandatedAuthority,
  parseSeparationOfDutiesRules,
  parseWorkflowStages,
  type ActiveWorkflowParticipants,
  type MandatedAuthority,
  type WorkflowParticipant,
  type WorkflowStage,
  type WorkflowTemplateValidationCode,
} from "../packages/domain/src/workflow-template.js";

const USER = "51000000-0000-0000-0001-000000000001";
const USER_TWO = "51000000-0000-0000-0001-000000000002";
const BODY = "51000000-0000-0000-0002-000000000001";
const MISSING = "51000000-0000-0000-0003-000000000001";

const active: ActiveWorkflowParticipants = {
  userIds: new Set([USER, USER_TWO]),
  governanceBodyIds: new Set([BODY]),
};
const user: WorkflowParticipant = { type: "USER", id: USER };
const userTwo: WorkflowParticipant = { type: "USER", id: USER_TWO };
const body: WorkflowParticipant = { type: "GOVERNANCE_BODY", id: BODY };

function stage(
  completionRule: WorkflowStage["completionRule"],
  participants: readonly WorkflowParticipant[],
  threshold?: number,
): WorkflowStage {
  return {
    order: 1,
    name: "Approval",
    completionRule,
    participants,
    ...(threshold === undefined ? {} : { threshold }),
  };
}

function mandate(...requires: WorkflowParticipant[]): MandatedAuthority {
  return { MATERIAL: { requires } };
}

function expectCode(run: () => unknown, code: WorkflowTemplateValidationCode): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowTemplateValidationError);
    expect((error as WorkflowTemplateValidationError).code).toBe(code);
  }
}

describe("workflow template mandate satisfaction", () => {
  it("INV-APR-020: binds participants only when the completion rule makes them indispensable", () => {
    expect(
      findUnmetMandateRequirement([stage("ALL", [user])], mandate(user), "MATERIAL"),
    ).toBeUndefined();
    expect(
      findUnmetMandateRequirement([stage("BODY_RESOLUTION", [body])], mandate(body), "MATERIAL"),
    ).toBeUndefined();
    expect(
      findUnmetMandateRequirement(
        [stage("AT_LEAST_N", [user, userTwo], 2)],
        mandate(user),
        "MATERIAL",
      ),
    ).toBeUndefined();
    expect(
      findUnmetMandateRequirement(
        [stage("AT_LEAST_N", [user, userTwo], 1)],
        mandate(user),
        "MATERIAL",
      ),
    ).toEqual({ materiality: "MATERIAL", participant: user });
    expect(
      findUnmetMandateRequirement([stage("ANY_ONE", [user])], mandate(user), "MATERIAL"),
    ).toEqual({ materiality: "MATERIAL", participant: user });
  });

  it("inherits an omitted materiality from the union of every stated class", () => {
    const authority: MandatedAuthority = {
      EDITORIAL: { requires: [user] },
      MATERIAL: { requires: [body, user] },
    };
    expect(effectiveMandateRequirements(authority, "NON_MATERIAL")).toEqual([user, body]);
    expect(effectiveMandateRequirements(authority, "EDITORIAL")).toEqual([user]);
  });
});

describe("workflow template Pilot parsers", () => {
  it("accepts serial one-participant ALL and BODY_RESOLUTION stages", () => {
    expect(
      parseWorkflowStages(
        [
          {
            order: 1,
            name: "Compliance",
            completionRule: "ALL",
            participants: [user],
          },
          {
            order: 2,
            name: "Board",
            completionRule: "BODY_RESOLUTION",
            participants: [body],
          },
        ],
        active,
      ),
    ).toHaveLength(2);
    expect(parseSeparationOfDutiesRules([])).toEqual([]);
  });

  it("refuses an empty requires list with its own error", () => {
    expectCode(
      () => parseMandatedAuthority({ MATERIAL: { requires: [] } }, active),
      "MANDATE_REQUIRES_EMPTY",
    );
  });

  it("refuses an unknown materiality with its own error", () => {
    expectCode(
      () => parseMandatedAuthority({ TRIVIAL: { requires: [user] } }, active),
      "UNKNOWN_MATERIALITY",
    );
  });

  it("refuses a participant that is absent or inactive in the tenant", () => {
    expectCode(
      () =>
        parseMandatedAuthority({ MATERIAL: { requires: [{ type: "USER", id: MISSING }] } }, active),
      "PARTICIPANT_NOT_ACTIVE",
    );
  });

  it("refuses skipped and repeated stage order with the ordering error", () => {
    const candidate = (orders: readonly number[]) =>
      orders.map((order) => ({
        order,
        name: "Review",
        completionRule: "ALL",
        participants: [user],
      }));
    expectCode(() => parseWorkflowStages(candidate([1, 3]), active), "STAGE_ORDER_INVALID");
    expectCode(() => parseWorkflowStages(candidate([1, 1]), active), "STAGE_ORDER_INVALID");
  });

  it("refuses a participant repeated within one stage before applying the Pilot count", () => {
    expectCode(
      () =>
        parseWorkflowStages(
          [
            {
              order: 1,
              name: "Review",
              completionRule: "ALL",
              participants: [user, user],
            },
          ],
          active,
        ),
      "DUPLICATE_PARTICIPANT",
    );
  });

  it("refuses BODY_RESOLUTION unless it has exactly one governance body", () => {
    expectCode(
      () =>
        parseWorkflowStages(
          [
            {
              order: 1,
              name: "Board",
              completionRule: "BODY_RESOLUTION",
              participants: [user],
            },
          ],
          active,
        ),
      "BODY_RESOLUTION_PARTICIPANT_INVALID",
    );
  });

  it("refuses a governance body under every other completion rule", () => {
    expectCode(
      () =>
        parseWorkflowStages(
          [
            {
              order: 1,
              name: "Board",
              completionRule: "ALL",
              participants: [body],
            },
          ],
          active,
        ),
      "GOVERNANCE_BODY_RULE_INVALID",
    );
  });

  it("refuses V1-only completion rules, participants and separation rules", () => {
    expectCode(
      () =>
        parseWorkflowStages(
          [
            {
              order: 1,
              name: "Review",
              completionRule: "ANY_ONE",
              participants: [user],
            },
          ],
          active,
        ),
      "COMPLETION_RULE_UNSUPPORTED_IN_PILOT",
    );
    expectCode(
      () =>
        parseMandatedAuthority(
          { MATERIAL: { requires: [{ type: "GROUP", id: MISSING }] } },
          active,
        ),
      "PARTICIPANT_TYPE_UNSUPPORTED_IN_PILOT",
    );
    expectCode(
      () => parseSeparationOfDutiesRules([{ kind: "AUTHOR_CANNOT_APPROVE" }]),
      "SEPARATION_OF_DUTIES_UNSUPPORTED_IN_PILOT",
    );
  });

  it("records the future editor authorization contract without enforcing a second path", () => {
    expect(WORKFLOW_TEMPLATE_REQUIRED_CAPABILITIES).toEqual({
      publish: "tenant.manage_configuration",
      assignToDocumentType: "tenant.manage_configuration",
    });
  });
});
