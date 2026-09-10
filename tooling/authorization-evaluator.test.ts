import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AuthzContext,
  decide,
  type AuthorizationDataLoader,
  type AuthorizationFacts,
  type AuthorizationGrant,
  type Capability,
  type ResourceRef,
  type ScopeRef,
} from "../packages/domain/src/authorization.js";

const TENANT = "10000000-0000-0000-0000-000000000001";
const FOREIGN_TENANT = "10000000-0000-0000-0000-000000000002";
const USER = "10000000-0000-0000-0001-000000000001";
const ENTITY = "10000000-0000-0000-0002-000000000001";
const UNIT = "10000000-0000-0000-0003-000000000001";
const DOCUMENT = "10000000-0000-0000-0004-000000000001";
const SIBLING_DOCUMENT = "10000000-0000-0000-0004-000000000002";
const BODY = "10000000-0000-0000-0005-000000000001";
const OTHER_BODY = "10000000-0000-0000-0005-000000000002";
const NOW = new Date("2030-01-02T12:00:00.000Z");

const DOCUMENT_RESOURCE: ResourceRef = {
  tenantId: TENANT,
  type: "DOCUMENT",
  id: DOCUMENT,
};
const DOCUMENT_SCOPES: readonly ScopeRef[] = [
  { type: "TENANT", id: null },
  { type: "LEGAL_ENTITY", id: ENTITY },
  { type: "ORG_UNIT", id: UNIT },
  { type: "DOCUMENT", id: DOCUMENT },
];

function currentValidity(until: Date | null = null) {
  return {
    from: new Date("2030-01-01T00:00:00.000Z"),
    fromInclusive: true,
    until,
    untilInclusive: false,
    empty: false,
  } as const;
}

interface GrantInput {
  readonly index: number;
  readonly effect?: "ALLOW" | "DENY";
  readonly capabilities?: readonly Capability[];
  readonly scope?: ScopeRef;
  readonly validity?: ReturnType<typeof currentValidity>;
}

function grant(input: GrantInput): AuthorizationGrant {
  return {
    ref: {
      tenantId: TENANT,
      id: `10000000-0000-0000-0006-${String(input.index).padStart(12, "0")}`,
    },
    effect: input.effect ?? "ALLOW",
    capabilities: input.capabilities ?? ["document.read"],
    scope: input.scope ?? { type: "TENANT", id: null },
    validity: input.validity ?? currentValidity(),
  };
}

function facts(overrides: Partial<AuthorizationFacts> = {}): AuthorizationFacts {
  return {
    resourceFound: true,
    principalActive: true,
    resourceScopes: DOCUMENT_SCOPES,
    grants: [],
    ...overrides,
  };
}

function context(load: AuthorizationDataLoader, instant = NOW): AuthzContext {
  return new AuthzContext({
    tenantId: TENANT,
    principal: { type: "USER", id: USER },
    instant,
    load,
  });
}

function fixedContext(value: AuthorizationFacts, instant = NOW): AuthzContext {
  return context(async () => value, instant);
}

describe("the single authorization evaluator", () => {
  it("INV-AUTH-001: defaults to a reasoned denial and returns the explaining grant on allow", async () => {
    const denied = await decide(fixedContext(facts()), "document.read", DOCUMENT_RESOURCE);
    const explainingGrant = grant({ index: 1 });
    const allowed = await decide(
      fixedContext(facts({ grants: [explainingGrant] })),
      "document.read",
      DOCUMENT_RESOURCE,
    );

    expect(denied).toEqual({ allowed: false, because: "NO_GRANT" });
    expect(allowed).toEqual({ allowed: true, via: explainingGrant.ref });
    expect(typeof denied).toBe("object");
    expect(typeof allowed).toBe("object");
  });

  it("INV-AUTH-002: DENY defeats ALLOW in either specificity and input order", async () => {
    const tenantDeny = grant({ index: 2, effect: "DENY" });
    const documentDeny = grant({
      index: 3,
      effect: "DENY",
      scope: { type: "DOCUMENT", id: DOCUMENT },
    });
    const tenantAllow = grant({ index: 4 });
    const documentAllow = grant({
      index: 5,
      scope: { type: "DOCUMENT", id: DOCUMENT },
    });

    for (const grants of [
      [documentAllow, tenantDeny],
      [tenantDeny, documentAllow],
      [tenantAllow, documentDeny],
      [documentDeny, tenantAllow],
    ]) {
      await expect(
        decide(fixedContext(facts({ grants })), "document.read", DOCUMENT_RESOURCE),
      ).resolves.toEqual({ allowed: false, because: "EXPLICIT_DENY" });
    }
  });

  it("INV-AUTH-003: evaluates grant expiry at the fixed decision instant", async () => {
    const endedOneSecondAgo = grant({
      index: 6,
      validity: currentValidity(new Date(NOW.valueOf() - 1_000)),
    });
    const beginsLater = grant({
      index: 7,
      validity: {
        ...currentValidity(),
        from: new Date(NOW.valueOf() + 1),
      },
    });

    await expect(
      decide(
        fixedContext(facts({ grants: [endedOneSecondAgo] })),
        "document.read",
        DOCUMENT_RESOURCE,
      ),
    ).resolves.toEqual({ allowed: false, because: "EXPIRED" });
    await expect(
      decide(fixedContext(facts({ grants: [beginsLater] })), "document.read", DOCUMENT_RESOURCE),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("INV-AUTH-004: memoises only inside one fixed-instant context", async () => {
    const expiringGrant = grant({
      index: 8,
      validity: currentValidity(new Date(NOW.valueOf() + 1_000)),
    });
    const load = vi.fn(async () => facts({ grants: [expiringGrant] }));
    const firstBoundary = context(load);

    await expect(decide(firstBoundary, "document.read", DOCUMENT_RESOURCE)).resolves.toEqual({
      allowed: true,
      via: expiringGrant.ref,
    });
    await expect(decide(firstBoundary, "document.read", DOCUMENT_RESOURCE)).resolves.toEqual({
      allowed: true,
      via: expiringGrant.ref,
    });
    expect(load).toHaveBeenCalledTimes(1);

    const nextBoundary = context(load, new Date(NOW.valueOf() + 1_001));
    await expect(decide(nextBoundary, "document.read", DOCUMENT_RESOURCE)).resolves.toEqual({
      allowed: false,
      because: "EXPIRED",
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("INV-AUTH-008 / INV-AUTH-017: a document grant reaches neither its ancestor nor a sibling", async () => {
    const documentGrant = grant({
      index: 9,
      scope: { type: "DOCUMENT", id: DOCUMENT },
    });
    const load: AuthorizationDataLoader = async ({ resource }) => {
      if (resource.type === "DOCUMENT" && resource.id === DOCUMENT) {
        return facts({ grants: [documentGrant] });
      }
      if (resource.type === "DOCUMENT") {
        return facts({
          resourceScopes: [
            { type: "TENANT", id: null },
            { type: "LEGAL_ENTITY", id: ENTITY },
            { type: "ORG_UNIT", id: UNIT },
            { type: "DOCUMENT", id: SIBLING_DOCUMENT },
          ],
          grants: [documentGrant],
        });
      }
      return facts({
        resourceScopes: [
          { type: "TENANT", id: null },
          { type: "LEGAL_ENTITY", id: ENTITY },
          { type: "ORG_UNIT", id: UNIT },
        ],
        grants: [documentGrant],
      });
    };
    const ctx = context(load);

    await expect(decide(ctx, "document.read", DOCUMENT_RESOURCE)).resolves.toEqual({
      allowed: true,
      via: documentGrant.ref,
    });
    await expect(
      decide(ctx, "document.read", { tenantId: TENANT, type: "ORG_UNIT", id: UNIT }),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
    await expect(
      decide(ctx, "document.read", {
        tenantId: TENANT,
        type: "DOCUMENT",
        id: SIBLING_DOCUMENT,
      }),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("expands a loaded role bundle and shares its resource facts across capabilities", async () => {
    const roleGrant = grant({
      index: 10,
      capabilities: ["document.read", "document.manage", "review.perform"],
    });
    const load = vi.fn(async () => facts({ grants: [roleGrant] }));
    const ctx = context(load);

    for (const capability of roleGrant.capabilities) {
      await expect(decide(ctx, capability, DOCUMENT_RESOURCE)).resolves.toEqual({
        allowed: true,
        via: roleGrant.ref,
      });
    }
    await expect(decide(ctx, "document.publish", DOCUMENT_RESOURCE)).resolves.toEqual({
      allowed: false,
      because: "NO_GRANT",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("INV-AUTH-014: inactive principals fail before a valid grant can authorize", async () => {
    await expect(
      decide(
        fixedContext(facts({ principalActive: false, grants: [grant({ index: 11 })] })),
        "document.read",
        DOCUMENT_RESOURCE,
      ),
    ).resolves.toEqual({ allowed: false, because: "PRINCIPAL_INACTIVE" });
  });

  it("keeps WRONG_TENANT internal while doing the same fact-load work as absence", async () => {
    const load = vi.fn<AuthorizationDataLoader>(async () => facts({ resourceFound: false }));

    await expect(
      decide(context(load), "document.read", {
        tenantId: FOREIGN_TENANT,
        type: "DOCUMENT",
        id: DOCUMENT,
      }),
    ).resolves.toEqual({ allowed: false, because: "WRONG_TENANT" });
    await expect(
      decide(context(load), "document.read", {
        tenantId: TENANT,
        type: "DOCUMENT",
        id: SIBLING_DOCUMENT,
      }),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("INV-AUTH-008: an exact Governance Body grant allows body.act_for for that body", async () => {
    const bodyGrant = grant({
      index: 12,
      capabilities: ["body.act_for"],
      scope: { type: "GOVERNANCE_BODY", id: BODY },
    });
    const ctx = fixedContext(
      facts({
        resourceScopes: [
          { type: "TENANT", id: null },
          { type: "LEGAL_ENTITY", id: ENTITY },
          { type: "GOVERNANCE_BODY", id: BODY },
        ],
        grants: [bodyGrant],
      }),
    );

    await expect(
      decide(ctx, "body.act_for", { tenantId: TENANT, type: "GOVERNANCE_BODY", id: BODY }),
    ).resolves.toEqual({ allowed: true, via: bodyGrant.ref });
  });

  it("INV-AUTH-008: a Governance Body grant cannot act for a different body", async () => {
    const bodyGrant = grant({
      index: 13,
      capabilities: ["body.act_for"],
      scope: { type: "GOVERNANCE_BODY", id: BODY },
    });
    const ctx = fixedContext(
      facts({
        resourceScopes: [
          { type: "TENANT", id: null },
          { type: "LEGAL_ENTITY", id: ENTITY },
          { type: "GOVERNANCE_BODY", id: OTHER_BODY },
        ],
        grants: [bodyGrant],
      }),
    );

    await expect(
      decide(ctx, "body.act_for", {
        tenantId: TENANT,
        type: "GOVERNANCE_BODY",
        id: OTHER_BODY,
      }),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("INV-AUTH-017: body.act_for rejects a matching id under a non-body scope type", async () => {
    const confusedGrant = grant({
      index: 14,
      capabilities: ["body.act_for"],
      scope: { type: "ORG_UNIT", id: BODY },
    });
    const ctx = fixedContext(
      facts({
        resourceScopes: [
          { type: "TENANT", id: null },
          { type: "LEGAL_ENTITY", id: ENTITY },
          { type: "GOVERNANCE_BODY", id: BODY },
        ],
        grants: [confusedGrant],
      }),
    );

    await expect(
      decide(ctx, "body.act_for", { tenantId: TENANT, type: "GOVERNANCE_BODY", id: BODY }),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("INV-AUTH-017: body.act_for cannot reach a non-body resource", async () => {
    const tenantGrant = grant({
      index: 15,
      capabilities: ["body.act_for"],
    });

    await expect(
      decide(fixedContext(facts({ grants: [tenantGrant] })), "body.act_for", DOCUMENT_RESOURCE),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("INV-AUTH-017: a body-scoped grant cannot reach a non-body resource", async () => {
    const bodyGrant = grant({
      index: 16,
      scope: { type: "GOVERNANCE_BODY", id: BODY },
    });
    const overBroadFacts = facts({
      // Keep the evaluator's guard observable even if a loader supplies an invalid scope chain.
      resourceScopes: [...DOCUMENT_SCOPES, { type: "GOVERNANCE_BODY", id: BODY }],
      grants: [bodyGrant],
    });

    await expect(
      decide(fixedContext(overBroadFacts), "document.read", DOCUMENT_RESOURCE),
    ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
  });

  it("exports exactly one decision function and no boolean decision variant", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../packages/domain/src/authorization.ts", import.meta.url)),
      "utf8",
    );
    const exportedFunctions = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
      (match) => match[1],
    );

    expect(exportedFunctions).toEqual(["decide"]);
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+(?:can|isAllowed|authorize)/);
  });
});
