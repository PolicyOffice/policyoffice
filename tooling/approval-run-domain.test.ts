import { describe, expect, it } from "vitest";
import {
  ApprovalRunActiveWorkflowVersionRequiredError,
  ApprovalRunMaterialityRequiredError,
  ApprovalRunWorkflowRequiredError,
  planApprovalRun,
  resolveApprovalRunParticipants,
} from "../packages/domain/src/index.js";

const DOCUMENT_TYPE = "a1000000-0000-0000-0001-000000000001";
const TEMPLATE = "a1000000-0000-0000-0002-000000000001";
const TEMPLATE_VERSION = "a1000000-0000-0000-0003-000000000001";
const USER = "a1000000-0000-0000-0004-000000000001";
const BODY = "a1000000-0000-0000-0005-000000000001";
const stages = [
  {
    order: 1,
    name: "Policy owner",
    completionRule: "ALL",
    participants: [{ type: "USER", id: USER }],
  },
  {
    order: 2,
    name: "Management Board",
    completionRule: "BODY_RESOLUTION",
    participants: [{ type: "GOVERNANCE_BODY", id: BODY }],
  },
];
const mandate = {
  MATERIAL: { requires: [{ type: "GOVERNANCE_BODY", id: BODY }] },
};

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    documentTypeId: DOCUMENT_TYPE,
    materiality: "MATERIAL" as const,
    workflowTemplateId: TEMPLATE,
    workflowTemplateVersionId: TEMPLATE_VERSION,
    stages,
    mandatedAuthority: mandate,
    ...overrides,
  };
}

describe("approval-run planning", () => {
  it("INV-APR-012: freezes one named participant set per template stage in order", () => {
    const plan = planApprovalRun(configuration());
    const resolved = resolveApprovalRunParticipants(plan, [
      { type: "USER", id: USER, displayName: "Maarja Tamm" },
      { type: "GOVERNANCE_BODY", id: BODY, displayName: "Management Board" },
    ]);

    expect(resolved).toEqual([
      {
        order: 1,
        participants: [{ type: "USER", id: USER, displayName: "Maarja Tamm" }],
      },
      {
        order: 2,
        participants: [{ type: "GOVERNANCE_BODY", id: BODY, displayName: "Management Board" }],
      },
    ]);
  });

  it("INV-APR-020: refuses a version with no materiality before any database is needed", () => {
    expect(() => planApprovalRun(configuration({ materiality: null }))).toThrow(
      ApprovalRunMaterialityRequiredError,
    );
  });

  it("refuses a document type with no workflow before any database is needed", () => {
    expect(() =>
      planApprovalRun(configuration({ workflowTemplateId: null, workflowTemplateVersionId: null })),
    ).toThrow(ApprovalRunWorkflowRequiredError);
  });

  it("refuses a workflow template with no active version before any database is needed", () => {
    expect(() => planApprovalRun(configuration({ workflowTemplateVersionId: null }))).toThrow(
      ApprovalRunActiveWorkflowVersionRequiredError,
    );
  });
});
