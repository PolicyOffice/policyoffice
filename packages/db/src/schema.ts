/**
 * The typed description of the schema built by 0003_tenancy_and_identity.sql.
 *
 * PostgreSQL mechanisms that Drizzle cannot render (FORCE ROW LEVEL SECURITY, triggers,
 * grants and comments) remain in the hand-written migration and are asserted directly by
 * integration tests. verify.ts supplies FORCE to the Drizzle-side throwaway database so
 * the drift comparison still checks the universal tenant-table convention.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { withTimezone: true });
const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });
const tenantPolicy = () =>
  pgPolicy("tenant_isolation", {
    using: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
  });

export const tenantStatus = pgEnum("tenant_status", ["ACTIVE", "SUSPENDED", "CLOSED"]);
export const appUserStatus = pgEnum("app_user_status", ["INVITED", "ACTIVE", "DEACTIVATED"]);
export const credentialKind = pgEnum("credential_kind", ["PASSWORD", "OIDC", "SAML"]);
export const userGroupSource = pgEnum("user_group_source", ["LOCAL", "SCIM"]);
export const userGroupStatus = pgEnum("user_group_status", ["ACTIVE", "RETIRED"]);

export const tenant = pgTable("tenant", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull(),
  defaultTimezone: text("default_timezone").notNull(),
  defaultLocale: text("default_locale").notNull(),
  residencyProfile: text("residency_profile").notNull(),
  governanceProfileCode: text("governance_profile_code"),
  createdAt: instant("created_at").defaultNow().notNull(),
});

export const appUser = pgTable(
  "app_user",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    externalIdentityId: text("external_identity_id"),
    displayName: text("display_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    status: appUserStatus("status").notNull(),
    locale: text("locale"),
    timezone: text("timezone"),
    deactivatedAt: instant("deactivated_at"),
  },
  (t) => [
    primaryKey({ name: "app_user_pkey", columns: [t.tenantId, t.id] }),
    unique("app_user_id_unique").on(t.id),
    foreignKey({
      name: "app_user_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("app_user_external_identity_unique").on(t.tenantId, t.externalIdentityId),
    uniqueIndex("app_user_tenant_email_unique").on(t.tenantId, sql`lower(${t.contactEmail})`),
    check(
      "app_user_deactivation_consistent",
      sql`(${t.status} = 'DEACTIVATED' and ${t.deactivatedAt} is not null)
          or (${t.status} <> 'DEACTIVATED' and ${t.deactivatedAt} is null)`,
    ),
    tenantPolicy(),
  ],
).enableRLS();

export const userCredential = pgTable(
  "user_credential",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    userId: uuid("user_id").notNull(),
    kind: credentialKind("kind").notNull(),
    secretHash: text("secret_hash").notNull(),
    params: jsonb("params").default({}).notNull(),
    rotatedAt: instant("rotated_at"),
  },
  (t) => [
    primaryKey({ name: "user_credential_pkey", columns: [t.tenantId, t.id] }),
    unique("user_credential_id_unique").on(t.id),
    foreignKey({
      name: "user_credential_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "user_credential_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    tenantPolicy(),
  ],
).enableRLS();

export const userSession = pgTable(
  "user_session",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    issuedAt: instant("issued_at").notNull(),
    idleExpiresAt: instant("idle_expires_at").notNull(),
    absoluteExpiresAt: instant("absolute_expires_at").notNull(),
    revokedAt: instant("revoked_at"),
    userAgentClass: text("user_agent_class").notNull(),
  },
  (t) => [
    primaryKey({ name: "user_session_pkey", columns: [t.tenantId, t.id] }),
    unique("user_session_id_unique").on(t.id),
    foreignKey({
      name: "user_session_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "user_session_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    tenantPolicy(),
  ],
).enableRLS();

export const userGroup = pgTable(
  "user_group",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    name: text("name").notNull(),
    source: userGroupSource("source").notNull(),
    externalId: text("external_id"),
    status: userGroupStatus("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "user_group_pkey", columns: [t.tenantId, t.id] }),
    unique("user_group_id_unique").on(t.id),
    foreignKey({
      name: "user_group_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    uniqueIndex("user_group_tenant_name_unique").on(t.tenantId, sql`lower(${t.name})`),
    tenantPolicy(),
  ],
).enableRLS();

export const groupMembership = pgTable(
  "group_membership",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
    validity: tstzrange("validity").notNull(),
  },
  (t) => [
    primaryKey({ name: "group_membership_pkey", columns: [t.tenantId, t.id] }),
    unique("group_membership_id_unique").on(t.id),
    foreignKey({
      name: "group_membership_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "group_membership_group_fk",
      columns: [t.tenantId, t.groupId],
      foreignColumns: [userGroup.tenantId, userGroup.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "group_membership_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    unique("group_membership_identity_validity_unique").on(
      t.tenantId,
      t.groupId,
      t.userId,
      t.validity,
    ),
    check(
      "group_membership_validity_half_open",
      sql`not isempty(${t.validity}) and lower_inc(${t.validity}) and not upper_inc(${t.validity})`,
    ),
    tenantPolicy(),
  ],
).enableRLS();

export const tenantEventSequence = pgTable(
  "tenant_event_sequence",
  {
    tenantId: uuid("tenant_id").notNull(),
    nextSequence: bigint("next_sequence", { mode: "bigint" })
      .default(sql`1`)
      .notNull(),
  },
  (t) => [
    primaryKey({ name: "tenant_event_sequence_pkey", columns: [t.tenantId] }),
    foreignKey({
      name: "tenant_event_sequence_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    check("tenant_event_sequence_positive", sql`${t.nextSequence} >= 1`),
    tenantPolicy(),
  ],
).enableRLS();

export const auditEvent = pgTable(
  "audit_event",
  {
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").defaultRandom().notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    eventType: text("event_type").notNull(),
    eventSchemaVersion: integer("event_schema_version").notNull(),
    occurredAt: instant("occurred_at").notNull(),
    recordedAt: instant("recorded_at").defaultNow().notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    originatingActorId: uuid("originating_actor_id"),
    elevationSessionId: uuid("elevation_session_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    documentId: uuid("document_id"),
    documentVariantId: uuid("document_variant_id"),
    documentVersionId: uuid("document_version_id"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    requestId: uuid("request_id"),
    correlationId: uuid("correlation_id").notNull(),
    sourceChannel: text("source_channel").notNull(),
    safeBefore: jsonb("safe_before"),
    safeAfter: jsonb("safe_after"),
    configurationVersionId: uuid("configuration_version_id"),
    correctsEventId: uuid("corrects_event_id"),
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    primaryKey({ name: "audit_event_pkey", columns: [t.tenantId, t.sequence] }),
    unique("audit_event_event_id_unique").on(t.eventId),
    foreignKey({
      name: "audit_event_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("audit_event_dedupe_unique").on(t.tenantId, t.dedupeKey),
    check("audit_event_sequence_positive", sql`${t.sequence} >= 1`),
    check("audit_event_type_name", sql`${t.eventType} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
    check("audit_event_schema_version_positive", sql`${t.eventSchemaVersion} >= 1`),
    check(
      "audit_event_actor_type",
      sql`${t.actorType} in ('USER', 'BODY', 'API_CLIENT', 'SYSTEM')`,
    ),
    check("audit_event_outcome", sql`${t.outcome} in ('SUCCESS', 'FAILURE')`),
    check("audit_event_source_channel", sql`${t.sourceChannel} in ('WEB', 'API', 'JOB', 'IMPORT')`),
    check(
      "audit_event_safe_snapshot_size",
      sql`coalesce(pg_column_size(${t.safeBefore}), 0)
          + coalesce(pg_column_size(${t.safeAfter}), 0) < 8192`,
    ),
    index("audit_event_document_sequence_idx").on(t.tenantId, t.documentId, t.sequence),
    index("audit_event_correlation_idx").on(t.tenantId, t.correlationId),
    tenantPolicy(),
  ],
).enableRLS();
