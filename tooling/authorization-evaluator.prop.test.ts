import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AuthzContext,
  decide,
  type AuthorizationGrant,
  type Capability,
  type ScopeRef,
} from "../packages/domain/src/authorization.js";

const TENANT = "20000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0001-000000000001";
const ENTITY = "20000000-0000-0000-0002-000000000001";
const UNIT = "20000000-0000-0000-0003-000000000001";
const DOCUMENT = "20000000-0000-0000-0004-000000000001";
const NOW = new Date("2030-01-02T12:00:00.000Z");

const scopes: readonly ScopeRef[] = [
  { type: "TENANT", id: null },
  { type: "LEGAL_ENTITY", id: ENTITY },
  { type: "ORG_UNIT", id: UNIT },
  { type: "DOCUMENT", id: DOCUMENT },
];

interface GeneratedGrant {
  readonly effect: "ALLOW" | "DENY";
  readonly capability: Capability;
  readonly scopeIndex: number;
  readonly current: boolean;
}

function grant(input: GeneratedGrant, index: number): AuthorizationGrant {
  return {
    ref: {
      tenantId: TENANT,
      id: `20000000-0000-0000-0005-${String(index).padStart(12, "0")}`,
    },
    effect: input.effect,
    capabilities: [input.capability],
    scope: scopes[input.scopeIndex] ?? scopes[0]!,
    validity: {
      from: new Date("2029-01-01T00:00:00.000Z"),
      fromInclusive: true,
      until: input.current ? null : new Date("2030-01-01T00:00:00.000Z"),
      untilInclusive: false,
      empty: false,
    },
  };
}

function decisionFor(grants: readonly AuthorizationGrant[], resourceScopes: readonly ScopeRef[]) {
  return decide(
    new AuthzContext({
      tenantId: TENANT,
      principal: { type: "USER", id: USER },
      instant: NOW,
      load: async () => ({
        resourceFound: true,
        principalActive: true,
        resourceScopes,
        grants,
      }),
    }),
    "document.read",
    { tenantId: TENANT, type: "DOCUMENT", id: DOCUMENT },
  );
}

describe("authorization decision properties", () => {
  it("INV-AUTH-002: a matching DENY wins for arbitrary grants and order permutations", async () => {
    const arbitraryGrant = fc.record<GeneratedGrant>({
      effect: fc.constantFrom("ALLOW", "DENY"),
      capability: fc.constantFrom("document.read", "document.manage", "review.perform"),
      scopeIndex: fc.integer({ min: 0, max: scopes.length - 1 }),
      current: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryGrant, { maxLength: 80 }),
        fc.integer({ min: 0, max: scopes.length - 1 }),
        fc.shuffledSubarray([...scopes], {
          minLength: scopes.length,
          maxLength: scopes.length,
        }),
        async (generated, denyScopeIndex, resourceScopes) => {
          const randomGrants = generated.map(grant);
          const requiredDeny = grant(
            {
              effect: "DENY",
              capability: "document.read",
              scopeIndex: denyScopeIndex,
              current: true,
            },
            generated.length + 1,
          );
          const permutations = [
            [requiredDeny, ...randomGrants],
            [...randomGrants, requiredDeny],
            [...randomGrants].reverse().concat(requiredDeny),
          ];

          for (const grants of permutations) {
            await expect(decisionFor(grants, resourceScopes)).resolves.toEqual({
              allowed: false,
              because: "EXPLICIT_DENY",
            });
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
