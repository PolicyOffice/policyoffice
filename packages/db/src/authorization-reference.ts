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

export type AuthorizationCapability = (typeof AUTHORIZATION_CAPABILITIES)[number];
export type AuthorizationScopeType = (typeof AUTHORIZATION_SCOPE_TYPES)[number];
export type GrantEffect = (typeof GRANT_EFFECTS)[number];

export interface SystemRoleSeed {
  readonly code: string;
  readonly name: string;
  readonly capabilities: readonly AuthorizationCapability[];
  readonly isSystem: true;
}

/**
 * The tenant-local system role seeds. The documentation-derived tooling gate keeps these
 * expanded capability bundles equal to authorization-model.md rather than trusting this list.
 */
export const SYSTEM_ROLE_SEEDS: readonly SystemRoleSeed[] = Object.freeze<SystemRoleSeed[]>([
  Object.freeze({
    code: "READER",
    name: "Reader",
    capabilities: Object.freeze(["document.read", "attestation.respond"] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "AUTHOR",
    name: "Author",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.create",
      "document.edit_draft",
      "document.submit",
      "document.read_history",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "REVIEWER",
    name: "Reviewer",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.read_history",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "APPROVER",
    name: "Approver",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.read_history",
      "document.approve",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "DOCUMENT_OWNER",
    name: "Document Owner",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.create",
      "document.edit_draft",
      "document.submit",
      "document.read_history",
      "document.manage",
      "document.manage_applicability",
      "review.perform",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "COMPLIANCE_ADMIN",
    name: "Compliance Admin",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.create",
      "document.edit_draft",
      "document.submit",
      "document.read_history",
      "document.manage",
      "document.manage_applicability",
      "review.perform",
      "document.publish",
      "document.withdraw",
      "document.cancel_version",
      "document.retire",
      "document.restore",
      "document.manage_access",
      "review.manage",
      "attestation.manage",
      "evidence.generate",
      "evidence.download",
      "audit.read",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "ENTITY_ADMIN",
    name: "Entity Admin",
    capabilities: Object.freeze([
      "document.read",
      "attestation.respond",
      "document.create",
      "document.edit_draft",
      "document.submit",
      "document.read_history",
      "document.manage",
      "document.manage_applicability",
      "review.perform",
      "document.publish",
      "document.withdraw",
      "document.cancel_version",
      "document.retire",
      "document.restore",
      "document.manage_access",
      "review.manage",
      "attestation.manage",
      "evidence.generate",
      "evidence.download",
      "audit.read",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "AUDITOR",
    name: "Auditor",
    capabilities: Object.freeze([
      "document.read",
      "document.read_history",
      "audit.read",
      "evidence.generate",
      "evidence.download",
    ] as const),
    isSystem: true,
  }),
  Object.freeze({
    code: "TENANT_ADMIN",
    name: "Tenant Admin",
    capabilities: Object.freeze([
      "tenant.manage_identity",
      "tenant.manage_configuration",
      "tenant.manage_security",
      "document.manage_access",
    ] as const),
    isSystem: true,
  }),
]);
