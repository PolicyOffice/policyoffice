/**
 * The domain package.
 *
 * This package is deliberately framework-free. It must never import Next.js, React, the
 * worker runtime, or anything that ties a rule to one entry point.
 *
 * The reason is not tidiness. Two invariants depend on it:
 *
 *   INV-TEN-004  Tenant scoping is enforced below the presentation layer, so background
 *                jobs and APIs inherit it. If the domain can reach into a request
 *                context, the enforcement point becomes request-scoped and the worker
 *                quietly gets a second copy of the rules.
 *
 *   INV-AUTH-001 Default deny, through ONE authorization evaluator with no second path
 *                around it. A domain that can import the framework invites that path.
 *
 * `ADR-0000` calls this "the single most important architectural boundary in the
 * repository" and predicts it "will be under constant pressure". It is enforced by
 * `tooling/architecture.test.ts`, which reads this package's imports and fails on
 * anything outside a stated allowlist -- not by anyone remembering.
 *
 * The package is intentionally almost empty. POL-002 builds the boundary; the contents
 * arrive with the tickets that need them.
 */

/** Marker for the domain module. Replaced by real exports as the model lands. */
export const DOMAIN_PACKAGE = "@policyoffice/domain" as const;

export {
  AUDIT_ACTOR_TYPES,
  AUDIT_EVENT_SCHEMAS,
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  AUDIT_SOURCE_CHANNELS,
  IMPLEMENTED_AUDIT_EVENT_TYPES,
  InvalidAuditEventError,
  emitAuditEvent,
  emitAuditEvents,
  validateAuditEvent,
  type AuditActorType,
  type AuditEventInput,
  type AuditEventSchema,
  type AuditEventType,
  type AuditOutcome,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
  type SafeAuditSnapshot,
  type SafeAuditValue,
} from "./audit.js";

export {
  CONFIGURATION_MANAGEMENT_CAPABILITY,
  recordConfigurationChange,
  type ConfigurationChangeInput,
  type RecordedConfigurationVersion,
} from "./configuration.js";
