import {
  AUTHORIZATION_CAPABILITIES,
  AUTHORIZATION_SCOPE_TYPES,
  GRANT_EFFECTS,
  type AuthorizationScopeType,
  type Capability,
  type GrantEffect,
} from "../../domain/src/authorization.js";

export { AUTHORIZATION_CAPABILITIES, AUTHORIZATION_SCOPE_TYPES, GRANT_EFFECTS };
export type AuthorizationCapability = Capability;
export type { AuthorizationScopeType, GrantEffect };

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
