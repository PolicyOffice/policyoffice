import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_CAPABILITIES,
  AuthzContext,
  decide,
  type AuthorizationFacts,
  type Decision,
  type GrantRef,
} from "../packages/domain/src/authorization.js";
import {
  AUTHORIZATION_MATRIX_GRANT_VALIDITIES,
  AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS,
  authorizationMatrixFacts,
  authorizationMatrixGrantValidity,
  authorizationMatrixProblems,
  buildAuthorizationMatrix,
  expectedAuthorizationMatrixDecision,
  type AuthorizationMatrixCell,
  type AuthorizationMatrixCoordinates,
} from "./authorization-matrix.js";
import { parseAuthorizationModel } from "./authorization-role-catalogue.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTHORIZATION_MODEL = readFileSync(join(ROOT, "docs/domain/authorization-model.md"), "utf8");
const MODEL = parseAuthorizationModel(AUTHORIZATION_MODEL);
const MATRIX = buildAuthorizationMatrix(MODEL, AUTHORIZATION_CAPABILITIES);

const TENANT_ID = "31000000-0000-0000-0000-000000000001";
const PRINCIPAL_ID = "31000000-0000-0000-0000-000000000002";
const DOCUMENT_ID = "31000000-0000-0000-0000-000000000003";
const VERSION_ID = "31000000-0000-0000-0000-000000000004";
const ORG_UNIT_ID = "31000000-0000-0000-0000-000000000005";
const ENTITY_ID = "31000000-0000-0000-0000-000000000006";
const SIBLING_DOCUMENT_ID = "31000000-0000-0000-0000-000000000007";
const UNRELATED_UNIT_ID = "31000000-0000-0000-0000-000000000008";
const ALLOW_GRANT: GrantRef = {
  tenantId: TENANT_ID,
  id: "31000000-0000-0000-0000-000000000009",
};
const DENY_GRANT: GrantRef = {
  tenantId: TENANT_ID,
  id: "31000000-0000-0000-0000-000000000010",
};
const NOW = new Date("2030-01-02T12:00:00.000Z");

const COORDINATES: AuthorizationMatrixCoordinates = {
  resource: { tenantId: TENANT_ID, type: "DOCUMENT", id: DOCUMENT_ID },
  resourceScopes: [
    { type: "TENANT", id: null },
    { type: "LEGAL_ENTITY", id: ENTITY_ID },
    { type: "ORG_UNIT", id: ORG_UNIT_ID },
    { type: "DOCUMENT", id: DOCUMENT_ID },
  ],
  grantScopes: {
    AT: { type: "DOCUMENT", id: DOCUMENT_ID },
    ANCESTOR: { type: "ORG_UNIT", id: ORG_UNIT_ID },
    DESCENDANT: { type: "DOCUMENT_VERSION", id: VERSION_ID },
    SIBLING: { type: "DOCUMENT", id: SIBLING_DOCUMENT_ID },
    UNRELATED: { type: "ORG_UNIT", id: UNRELATED_UNIT_ID },
  },
};

function decisionFor(cell: AuthorizationMatrixCell, facts: AuthorizationFacts): Promise<Decision> {
  const context = new AuthzContext({
    tenantId: TENANT_ID,
    principal: { type: "USER", id: PRINCIPAL_ID },
    instant: NOW,
    load: () => Promise.resolve(facts),
  });
  return decide(context, cell.capability, COORDINATES.resource);
}

function difference(cell: AuthorizationMatrixCell, expected: Decision, actual: Decision): string {
  return `${cell.key}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

describe("generated authorization matrix", () => {
  it("INV-AUTH-016: covers every documented role, runtime capability, scope relationship and validity", () => {
    expect(authorizationMatrixProblems(MODEL, AUTHORIZATION_CAPABILITIES)).toEqual([]);
    expect(MODEL.roles).toHaveLength(9);
    expect(AUTHORIZATION_CAPABILITIES).toHaveLength(30);
    expect(MATRIX).toHaveLength(
      MODEL.roles.length *
        AUTHORIZATION_CAPABILITIES.length *
        AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS.length *
        AUTHORIZATION_MATRIX_GRANT_VALIDITIES.length,
    );

    for (const role of MODEL.roles) {
      const roleCells = MATRIX.filter((cell) => cell.roleCode === role.code);
      expect(new Set(roleCells.map((cell) => cell.capability))).toEqual(
        new Set(AUTHORIZATION_CAPABILITIES),
      );
      expect(new Set(roleCells.map((cell) => cell.scopeRelationship))).toEqual(
        new Set(AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS),
      );
      expect(new Set(roleCells.map((cell) => cell.grantValidity))).toEqual(
        new Set(AUTHORIZATION_MATRIX_GRANT_VALIDITIES),
      );
    }
  });

  it("fails closed and names a runtime capability without a documented matrix decision", () => {
    const changedRuntime = [...AUTHORIZATION_CAPABILITIES, "document.archive"];
    expect(() => buildAuthorizationMatrix(MODEL, changedRuntime)).toThrow(
      "document.archive: runtime capability has no documented matrix decision",
    );
  });

  it("regenerates a changed role row from the authorization model without generator edits", () => {
    const changedDocument = AUTHORIZATION_MODEL.replace(
      "| **Reader** | `document.read`, `attestation.respond` |",
      "| **Reader** | `document.read`, `attestation.respond`, `document.publish` |",
    );
    expect(changedDocument).not.toBe(AUTHORIZATION_MODEL);

    const changedMatrix = buildAuthorizationMatrix(
      parseAuthorizationModel(changedDocument),
      AUTHORIZATION_CAPABILITIES,
    );
    expect(
      changedMatrix.find(
        (cell) =>
          cell.roleCode === "READER" &&
          cell.capability === "document.publish" &&
          cell.scopeRelationship === "AT" &&
          cell.grantValidity === "CURRENT",
      )?.roleHasCapability,
    ).toBe(true);
  });

  it("INV-AUTH-001 / INV-AUTH-003 / INV-AUTH-008: evaluates all 4,050 generated cells", async () => {
    const failures: string[] = [];
    for (const cell of MATRIX) {
      const facts = authorizationMatrixFacts(cell, COORDINATES, NOW, ALLOW_GRANT);
      const expected = expectedAuthorizationMatrixDecision(cell, ALLOW_GRANT);
      const actual = await decisionFor(cell, facts);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(difference(cell, expected, actual));
      }
    }
    expect(failures).toEqual([]);
  });

  it("INV-AUTH-001: denies every role and capability pair when there is no grant", async () => {
    const failures: string[] = [];
    const pairs = MATRIX.filter(
      (cell) => cell.scopeRelationship === "AT" && cell.grantValidity === "CURRENT",
    );
    for (const cell of pairs) {
      const facts = authorizationMatrixFacts(cell, COORDINATES, NOW, ALLOW_GRANT);
      const actual = await decisionFor(cell, { ...facts, grants: [] });
      const expected: Decision = { allowed: false, because: "NO_GRANT" };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(difference(cell, expected, actual));
      }
    }
    expect(failures).toEqual([]);
  });

  it("INV-AUTH-002: a deny defeats each otherwise-applicable role allow at either scope", async () => {
    const failures: string[] = [];
    const otherwiseAllowed = MATRIX.filter(
      (cell) =>
        cell.roleHasCapability &&
        cell.grantValidity === "CURRENT" &&
        (cell.scopeRelationship === "AT" || cell.scopeRelationship === "ANCESTOR"),
    );

    for (const cell of otherwiseAllowed) {
      const facts = authorizationMatrixFacts(cell, COORDINATES, NOW, ALLOW_GRANT);
      const denyScope =
        cell.scopeRelationship === "AT"
          ? COORDINATES.grantScopes.ANCESTOR
          : COORDINATES.grantScopes.AT;
      const actual = await decisionFor(cell, {
        ...facts,
        grants: [
          ...facts.grants,
          {
            ref: DENY_GRANT,
            effect: "DENY",
            capabilities: [cell.capability],
            scope: denyScope,
            validity: authorizationMatrixGrantValidity("CURRENT", NOW),
          },
        ],
      });
      const expected: Decision = { allowed: false, because: "EXPLICIT_DENY" };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(difference(cell, expected, actual));
      }
    }
    expect(failures).toEqual([]);
  });
});
