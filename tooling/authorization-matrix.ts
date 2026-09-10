import type {
  AuthorizationFacts,
  Capability,
  Decision,
  GrantRef,
  GrantValidity,
  ResourceRef,
  ScopeRef,
} from "../packages/domain/src/authorization.js";
import type { AuthorizationModelDefinition } from "./authorization-role-catalogue.js";

export const AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS = Object.freeze([
  "AT",
  "ANCESTOR",
  "DESCENDANT",
  "SIBLING",
  "UNRELATED",
] as const);

export const AUTHORIZATION_MATRIX_GRANT_VALIDITIES = Object.freeze([
  "CURRENT",
  "EXPIRED",
  "NOT_YET_STARTED",
] as const);

export type AuthorizationMatrixScopeRelationship =
  (typeof AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS)[number];
export type AuthorizationMatrixGrantValidity =
  (typeof AUTHORIZATION_MATRIX_GRANT_VALIDITIES)[number];

export interface AuthorizationMatrixCell {
  readonly key: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly roleCapabilities: readonly Capability[];
  readonly capability: Capability;
  readonly scopeRelationship: AuthorizationMatrixScopeRelationship;
  readonly grantValidity: AuthorizationMatrixGrantValidity;
  readonly roleHasCapability: boolean;
}

export interface AuthorizationMatrixCoordinates {
  readonly resource: ResourceRef;
  readonly resourceScopes: readonly ScopeRef[];
  readonly grantScopes: Readonly<Record<AuthorizationMatrixScopeRelationship, ScopeRef>>;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

/**
 * The document is the matrix source. A new runtime capability cannot receive an implicit
 * all-denied row: it must first be named in the documented capability catalogue.
 */
export function authorizationMatrixProblems(
  model: AuthorizationModelDefinition,
  runtimeCapabilities: readonly string[],
): string[] {
  const problems: string[] = [];
  const documentedCapabilities = new Set(model.capabilities);
  const runtimeCapabilitySet = new Set(runtimeCapabilities);

  for (const capability of duplicates(model.capabilities)) {
    problems.push(`${capability}: capability is duplicated in the matrix source`);
  }
  for (const capability of duplicates(runtimeCapabilities)) {
    problems.push(`${capability}: capability is duplicated in the runtime enumeration`);
  }
  for (const capability of runtimeCapabilitySet) {
    if (!documentedCapabilities.has(capability)) {
      problems.push(`${capability}: runtime capability has no documented matrix decision`);
    }
  }
  for (const capability of documentedCapabilities) {
    if (!runtimeCapabilitySet.has(capability)) {
      problems.push(
        `${capability}: documented matrix capability is absent from the runtime enumeration`,
      );
    }
  }

  for (const code of duplicates(model.roles.map((role) => role.code))) {
    problems.push(`${code}: role is duplicated in the matrix source`);
  }
  for (const role of model.roles) {
    for (const capability of role.capabilities) {
      if (!runtimeCapabilitySet.has(capability)) {
        problems.push(`${role.code}: role names unsupported capability ${capability}`);
      }
    }
  }

  return problems.sort();
}

export function buildAuthorizationMatrix(
  model: AuthorizationModelDefinition,
  runtimeCapabilities: readonly string[],
): readonly AuthorizationMatrixCell[] {
  const problems = authorizationMatrixProblems(model, runtimeCapabilities);
  if (problems.length > 0) {
    throw new Error(`authorization matrix source is invalid:\n${problems.join("\n")}`);
  }

  return model.roles.flatMap((role) => {
    const roleCapabilities = role.capabilities as readonly Capability[];
    const held = new Set(roleCapabilities);
    return runtimeCapabilities.flatMap((runtimeCapability) => {
      const capability = runtimeCapability as Capability;
      return AUTHORIZATION_MATRIX_SCOPE_RELATIONSHIPS.flatMap((scopeRelationship) =>
        AUTHORIZATION_MATRIX_GRANT_VALIDITIES.map((grantValidity) => ({
          key: [role.code, capability, scopeRelationship, grantValidity].join(" / "),
          roleCode: role.code,
          roleName: role.name,
          roleCapabilities,
          capability,
          scopeRelationship,
          grantValidity,
          roleHasCapability: held.has(capability),
        })),
      );
    });
  });
}

export function authorizationMatrixGrantValidity(
  validity: AuthorizationMatrixGrantValidity,
  instant: Date,
): GrantValidity {
  const day = 24 * 60 * 60 * 1_000;
  if (validity === "CURRENT") {
    return {
      from: new Date(instant.valueOf() - day),
      fromInclusive: true,
      until: new Date(instant.valueOf() + day),
      untilInclusive: false,
      empty: false,
    };
  }
  if (validity === "EXPIRED") {
    return {
      from: new Date(instant.valueOf() - 2 * day),
      fromInclusive: true,
      until: new Date(instant.valueOf() - day),
      untilInclusive: false,
      empty: false,
    };
  }
  return {
    from: new Date(instant.valueOf() + day),
    fromInclusive: true,
    until: new Date(instant.valueOf() + 2 * day),
    untilInclusive: false,
    empty: false,
  };
}

export function authorizationMatrixFacts(
  cell: AuthorizationMatrixCell,
  coordinates: AuthorizationMatrixCoordinates,
  instant: Date,
  grantRef: GrantRef,
): AuthorizationFacts {
  return {
    resourceFound: true,
    principalActive: true,
    resourceScopes: coordinates.resourceScopes,
    grants: [
      {
        ref: grantRef,
        effect: "ALLOW",
        capabilities: cell.roleCapabilities,
        scope: coordinates.grantScopes[cell.scopeRelationship],
        validity: authorizationMatrixGrantValidity(cell.grantValidity, instant),
      },
    ],
  };
}

export function expectedAuthorizationMatrixDecision(
  cell: AuthorizationMatrixCell,
  grantRef: GrantRef,
): Decision {
  const scopeApplies = cell.scopeRelationship === "AT" || cell.scopeRelationship === "ANCESTOR";
  if (!cell.roleHasCapability || !scopeApplies || cell.grantValidity === "NOT_YET_STARTED") {
    return { allowed: false, because: "NO_GRANT" };
  }
  if (cell.grantValidity === "EXPIRED") {
    return { allowed: false, because: "EXPIRED" };
  }
  return { allowed: true, via: grantRef };
}
