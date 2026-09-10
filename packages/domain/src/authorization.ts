/** Closed authorization vocabulary shared by the evaluator and persistence adapter. */
export const AUTHORIZATION_CAPABILITIES = Object.freeze([
  "document.read",
  "document.read_history",
  "document.create",
  "document.edit_draft",
  "document.submit",
  "document.approve",
  "document.publish",
  "document.withdraw",
  "document.cancel_version",
  "document.manage",
  "document.retire",
  "document.restore",
  "document.manage_applicability",
  "document.manage_access",
  "variant.create",
  "review.perform",
  "review.manage",
  "attestation.respond",
  "attestation.manage",
  "waiver.request",
  "waiver.approve",
  "evidence.generate",
  "evidence.download",
  "audit.read",
  "body.act_for",
  "tenant.manage_identity",
  "tenant.manage_configuration",
  "tenant.manage_security",
  "tenant.manage_retention",
  "tenant.break_glass",
] as const);

export const AUTHORIZATION_SCOPE_TYPES = Object.freeze([
  "TENANT",
  "LEGAL_ENTITY",
  "ORG_UNIT",
  "DOCUMENT",
  "DOCUMENT_VARIANT",
  "DOCUMENT_VERSION",
  "GOVERNANCE_BODY",
] as const);

export const GRANT_EFFECTS = Object.freeze(["ALLOW", "DENY"] as const);
export const AUTHORIZATION_PRINCIPAL_TYPES = Object.freeze([
  "USER",
  "GROUP",
  "API_CLIENT",
] as const);

export type Capability = (typeof AUTHORIZATION_CAPABILITIES)[number];
export type AuthorizationScopeType = (typeof AUTHORIZATION_SCOPE_TYPES)[number];
export type GrantEffect = (typeof GRANT_EFFECTS)[number];
export type AuthorizationPrincipalType = (typeof AUTHORIZATION_PRINCIPAL_TYPES)[number];

/**
 * Authorization contracts only. Grant creation and revocation entry points must establish
 * this capability before writing an access grant.
 */
export const ACCESS_GRANT_REQUIRED_CAPABILITIES = Object.freeze({
  grant: "document.manage_access",
  revoke: "document.manage_access",
} as const);

export interface PrincipalRef {
  readonly type: AuthorizationPrincipalType;
  readonly id: string;
}

export type ScopeRef =
  | Readonly<{ type: "TENANT"; id: null }>
  | Readonly<{
      type: Exclude<AuthorizationScopeType, "TENANT">;
      id: string;
    }>;

export type ResourceRef = ScopeRef & Readonly<{ tenantId: string }>;

export interface GrantRef {
  readonly tenantId: string;
  readonly id: string;
}

export interface GrantValidity {
  readonly from: Date | null;
  readonly fromInclusive: boolean;
  readonly until: Date | null;
  readonly untilInclusive: boolean;
  readonly empty: boolean;
}

export interface AuthorizationGrant {
  readonly ref: GrantRef;
  readonly effect: GrantEffect;
  readonly capabilities: readonly Capability[];
  readonly scope: ScopeRef;
  readonly validity: GrantValidity;
}

/**
 * Facts loaded under the caller's tenant-scoped transaction. The resource scopes are its
 * own coordinate followed only by administrative ancestors; never descendants,
 * applicability, Space, or classification.
 */
export interface AuthorizationFacts {
  readonly resourceFound: boolean;
  readonly principalActive: boolean;
  readonly resourceScopes: readonly ScopeRef[];
  readonly grants: readonly AuthorizationGrant[];
}

export interface AuthorizationLoadRequest {
  readonly tenantId: string;
  readonly principal: PrincipalRef;
  readonly instant: Date;
  readonly resource: ResourceRef;
}

export type AuthorizationDataLoader = (
  request: AuthorizationLoadRequest,
) => Promise<AuthorizationFacts>;

export type DecisionReason =
  "NO_GRANT" | "EXPLICIT_DENY" | "EXPIRED" | "PRINCIPAL_INACTIVE" | "WRONG_TENANT";

export type Decision =
  | Readonly<{ allowed: true; via: GrantRef }>
  | Readonly<{ allowed: false; because: DecisionReason }>;

export interface AuthzContextInput {
  readonly tenantId: string;
  readonly principal: PrincipalRef;
  /** Fixed at request or job start; a new boundary creates a new context and memo. */
  readonly instant: Date;
  readonly load: AuthorizationDataLoader;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireInstant(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function requirePrincipal(principal: PrincipalRef): void {
  if (!AUTHORIZATION_PRINCIPAL_TYPES.includes(principal.type)) {
    throw new TypeError("principal.type is not supported");
  }
  requireUuid(principal.id, "principal.id");
}

function requireResource(resource: ResourceRef): void {
  requireUuid(resource.tenantId, "resource.tenantId");
  if (!AUTHORIZATION_SCOPE_TYPES.includes(resource.type)) {
    throw new TypeError("resource.type is not supported");
  }
  if (resource.type === "TENANT") {
    if (resource.id !== null) throw new TypeError("a tenant resource has no separate id");
  } else {
    requireUuid(resource.id, "resource.id");
  }
}

function memoKey(resource: ResourceRef): string {
  return `${resource.tenantId}:${resource.type}:${resource.id ?? ""}`;
}

const LOAD_CONTEXT_FACTS = Symbol("load authorization context facts");

/**
 * One request/job authorization boundary. Its fixed instant and private memo cannot survive
 * unless the caller deliberately reuses the context, which POL-026 will prevent at entry
 * points. No principal or cache is ambient or module-global.
 */
export class AuthzContext {
  readonly tenantId: string;
  readonly principal: PrincipalRef;
  private readonly instantMillis: number;
  private readonly loadFacts: AuthorizationDataLoader;
  private readonly memo = new Map<string, Promise<AuthorizationFacts>>();

  constructor(input: AuthzContextInput) {
    requireUuid(input.tenantId, "tenantId");
    requirePrincipal(input.principal);
    requireInstant(input.instant, "instant");
    if (typeof input.load !== "function") throw new TypeError("load must be a function");

    this.tenantId = input.tenantId;
    this.principal = Object.freeze({ ...input.principal });
    this.instantMillis = input.instant.valueOf();
    this.loadFacts = input.load;
  }

  get instant(): Date {
    return new Date(this.instantMillis);
  }

  async [LOAD_CONTEXT_FACTS](resource: ResourceRef): Promise<AuthorizationFacts> {
    const key = memoKey(resource);
    const existing = this.memo.get(key);
    if (existing) return existing;

    const pending = this.loadFacts({
      tenantId: this.tenantId,
      principal: this.principal,
      instant: this.instant,
      resource: Object.freeze({ ...resource }) as ResourceRef,
    });
    this.memo.set(key, pending);
    return pending;
  }
}

function denial(because: DecisionReason): Decision {
  return Object.freeze({ allowed: false, because });
}

function scopeEquals(left: ScopeRef, right: ScopeRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function scopeContains(
  grant: AuthorizationGrant,
  resource: ResourceRef,
  resourceScopes: readonly ScopeRef[],
  capability: Capability,
): boolean {
  // Acting for a body is authority over one named body, never a broad organisational role.
  if (resource.type === "GOVERNANCE_BODY" || capability === "body.act_for") {
    return (
      resource.type === "GOVERNANCE_BODY" &&
      capability === "body.act_for" &&
      grant.scope.type === "GOVERNANCE_BODY" &&
      grant.scope.id === resource.id
    );
  }
  if (grant.scope.type === "GOVERNANCE_BODY") return false;
  return resourceScopes.some((scope) => scopeEquals(scope, grant.scope));
}

function grantIsCurrent(validity: GrantValidity, instant: Date): boolean {
  if (validity.empty) return false;
  const at = instant.valueOf();
  const from = validity.from?.valueOf();
  const until = validity.until?.valueOf();
  const afterStart = from === undefined || at > from || (at === from && validity.fromInclusive);
  const beforeEnd = until === undefined || at < until || (at === until && validity.untilInclusive);
  return afterStart && beforeEnd;
}

function grantHasEnded(validity: GrantValidity, instant: Date): boolean {
  if (validity.empty || validity.until === null) return false;
  const at = instant.valueOf();
  const until = validity.until.valueOf();
  return at > until || (at === until && !validity.untilInclusive);
}

function capabilitySupported(value: string): value is Capability {
  return AUTHORIZATION_CAPABILITIES.some((capability) => capability === value);
}

/**
 * The one ADR-0003 authorization decision function. WRONG_TENANT is internal evidence for
 * tests and telemetry; every external boundary must collapse it to the same not-found shape
 * and comparable timing as an absent resource.
 */
export async function decide(
  ctx: AuthzContext,
  capability: Capability,
  resource: ResourceRef,
): Promise<Decision> {
  if (!(ctx instanceof AuthzContext)) throw new TypeError("ctx must be an AuthzContext");
  if (!capabilitySupported(capability)) throw new TypeError("capability is not supported");
  requireResource(resource);

  // Load first for both foreign and absent resources. The internal reason differs, but the
  // work performed does not become a cross-tenant existence oracle.
  const facts = await ctx[LOAD_CONTEXT_FACTS](resource);
  if (resource.tenantId !== ctx.tenantId) return denial("WRONG_TENANT");
  if (!facts.resourceFound) return denial("NO_GRANT");
  if (!facts.principalActive) return denial("PRINCIPAL_INACTIVE");

  const instant = ctx.instant;
  let allowedBy: GrantRef | undefined;
  let expiredAllow = false;

  for (const grant of facts.grants) {
    if (grant.ref.tenantId !== ctx.tenantId) continue;
    if (!grant.capabilities.includes(capability)) continue;
    if (!scopeContains(grant, resource, facts.resourceScopes, capability)) continue;

    if (grantIsCurrent(grant.validity, instant)) {
      if (grant.effect === "DENY") return denial("EXPLICIT_DENY");
      if (!allowedBy) allowedBy = grant.ref;
    } else if (grant.effect === "ALLOW" && grantHasEnded(grant.validity, instant)) {
      expiredAllow = true;
    }
  }

  if (allowedBy) {
    return Object.freeze({
      allowed: true,
      via: Object.freeze({ tenantId: allowedBy.tenantId, id: allowedBy.id }),
    });
  }
  return denial(expiredAllow ? "EXPIRED" : "NO_GRANT");
}
