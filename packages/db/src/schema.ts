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
  boolean,
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
export const legalEntityStatus = pgEnum("legal_entity_status", ["ACTIVE", "DORMANT", "CLOSED"]);
export const orgUnitStatus = pgEnum("org_unit_status", ["ACTIVE", "INACTIVE"]);
export const jurisdictionLevel = pgEnum("jurisdiction_level", [
  "SUPRANATIONAL",
  "NATIONAL",
  "REGIONAL",
  "SECTORAL",
]);
export const jurisdictionStatus = pgEnum("jurisdiction_status", ["ACTIVE", "RETIRED"]);
export const governanceBodyStatus = pgEnum("governance_body_status", ["ACTIVE", "DISSOLVED"]);
export const governanceSeatRole = pgEnum("governance_seat_role", ["CHAIR", "SECRETARY", "MEMBER"]);
export const spaceStatus = pgEnum("space_status", ["ACTIVE", "ARCHIVED"]);
export const documentTypeStatus = pgEnum("document_type_status", ["ACTIVE", "RETIRED"]);
export const informationClassificationStatus = pgEnum("information_classification_status", [
  "ACTIVE",
  "RETIRED",
]);
export const documentLifecycle = pgEnum("document_lifecycle", ["PLANNED", "ACTIVE", "RETIRED"]);
export const variantType = pgEnum("variant_type", [
  "BASELINE",
  "REPLACEMENT",
  "SUPPLEMENT",
  "TRANSLATION",
]);
export const versionLifecycle = pgEnum("version_lifecycle", [
  "DRAFT",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "PUBLISHED",
  "EFFECTIVE",
  "SUPERSEDED",
  "WITHDRAWN",
  "REJECTED",
  "CANCELLED",
]);
export const materiality = pgEnum("materiality", [
  "EDITORIAL",
  "NON_MATERIAL",
  "MATERIAL",
  "EMERGENCY",
]);

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

export const legalEntity = pgTable(
  "legal_entity",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    legalName: text("legal_name").notNull(),
    registrationNumber: text("registration_number"),
    countryOfRegistration: text("country_of_registration"),
    parentLegalEntityId: uuid("parent_legal_entity_id"),
    status: legalEntityStatus("status").notNull(),
    closedAt: instant("closed_at"),
  },
  (t) => [
    primaryKey({ name: "legal_entity_pkey", columns: [t.tenantId, t.id] }),
    unique("legal_entity_id_unique").on(t.id),
    foreignKey({
      name: "legal_entity_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "legal_entity_parent_fk",
      columns: [t.tenantId, t.parentLegalEntityId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    check("legal_entity_not_own_parent", sql`${t.id} <> ${t.parentLegalEntityId}`),
    check(
      "legal_entity_closure_consistent",
      sql`(${t.status} = 'CLOSED' and ${t.closedAt} is not null)
          or (${t.status} <> 'CLOSED' and ${t.closedAt} is null)`,
    ),
    index("legal_entity_parent_idx").on(t.tenantId, t.parentLegalEntityId),
    tenantPolicy(),
  ],
).enableRLS();

export const orgUnit = pgTable(
  "org_unit",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    name: text("name").notNull(),
    code: text("code"),
    legalEntityId: uuid("legal_entity_id").notNull(),
    parentOrgUnitId: uuid("parent_org_unit_id"),
    status: orgUnitStatus("status").notNull(),
    closedAt: instant("closed_at"),
  },
  (t) => [
    primaryKey({ name: "org_unit_pkey", columns: [t.tenantId, t.id] }),
    unique("org_unit_id_unique").on(t.id),
    foreignKey({
      name: "org_unit_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "org_unit_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntity.tenantId, legalEntity.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "org_unit_parent_fk",
      columns: [t.tenantId, t.parentOrgUnitId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    check("org_unit_not_own_parent", sql`${t.id} <> ${t.parentOrgUnitId}`),
    check(
      "org_unit_closure_consistent",
      sql`(${t.status} = 'INACTIVE' and ${t.closedAt} is not null)
          or (${t.status} <> 'INACTIVE' and ${t.closedAt} is null)`,
    ),
    index("org_unit_legal_entity_idx").on(t.tenantId, t.legalEntityId),
    index("org_unit_parent_idx").on(t.tenantId, t.parentOrgUnitId),
    tenantPolicy(),
  ],
).enableRLS();

export const jurisdiction = pgTable(
  "jurisdiction",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    level: jurisdictionLevel("level").notNull(),
    status: jurisdictionStatus("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "jurisdiction_pkey", columns: [t.tenantId, t.id] }),
    unique("jurisdiction_id_unique").on(t.id),
    foreignKey({
      name: "jurisdiction_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("jurisdiction_tenant_code_unique").on(t.tenantId, t.code),
    tenantPolicy(),
  ],
).enableRLS();

export const orgMembership = pgTable(
  "org_membership",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    userId: uuid("user_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    orgUnitId: uuid("org_unit_id").notNull(),
    validity: tstzrange("validity").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    jurisdictionIds: uuid("jurisdiction_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
  },
  (t) => [
    primaryKey({ name: "org_membership_pkey", columns: [t.tenantId, t.id] }),
    unique("org_membership_id_unique").on(t.id),
    foreignKey({
      name: "org_membership_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "org_membership_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "org_membership_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntity.tenantId, legalEntity.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "org_membership_org_unit_fk",
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnit.tenantId, orgUnit.id],
    }).onDelete("restrict"),
    check(
      "org_membership_validity_half_open",
      sql`not isempty(${t.validity}) and lower_inc(${t.validity}) and not upper_inc(${t.validity})`,
    ),
    index("org_membership_user_validity_idx").using("gist", t.tenantId, t.userId, t.validity),
    index("org_membership_legal_entity_idx").on(t.tenantId, t.legalEntityId),
    index("org_membership_org_unit_idx").on(t.tenantId, t.orgUnitId),
    tenantPolicy(),
  ],
).enableRLS();

export const governanceBody = pgTable(
  "governance_body",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    parentBodyId: uuid("parent_body_id"),
    quorumRule: jsonb("quorum_rule").default({}).notNull(),
    status: governanceBodyStatus("status").notNull(),
    closedAt: instant("closed_at"),
  },
  (t) => [
    primaryKey({ name: "governance_body_pkey", columns: [t.tenantId, t.id] }),
    unique("governance_body_id_unique").on(t.id),
    foreignKey({
      name: "governance_body_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("governance_body_tenant_code_unique").on(t.tenantId, t.code),
    foreignKey({
      name: "governance_body_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntity.tenantId, legalEntity.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "governance_body_parent_fk",
      columns: [t.tenantId, t.parentBodyId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    check("governance_body_not_own_parent", sql`${t.id} <> ${t.parentBodyId}`),
    check(
      "governance_body_closure_consistent",
      sql`(${t.status} = 'DISSOLVED' and ${t.closedAt} is not null)
          or (${t.status} <> 'DISSOLVED' and ${t.closedAt} is null)`,
    ),
    index("governance_body_legal_entity_idx").on(t.tenantId, t.legalEntityId),
    index("governance_body_parent_idx").on(t.tenantId, t.parentBodyId),
    tenantPolicy(),
  ],
).enableRLS();

export const bodyMembership = pgTable(
  "body_membership",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    bodyId: uuid("body_id").notNull(),
    userId: uuid("user_id").notNull(),
    seatRole: governanceSeatRole("seat_role"),
    validity: tstzrange("validity").notNull(),
  },
  (t) => [
    primaryKey({ name: "body_membership_pkey", columns: [t.tenantId, t.id] }),
    unique("body_membership_id_unique").on(t.id),
    foreignKey({
      name: "body_membership_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "body_membership_body_fk",
      columns: [t.tenantId, t.bodyId],
      foreignColumns: [governanceBody.tenantId, governanceBody.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "body_membership_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    check(
      "body_membership_validity_half_open",
      sql`not isempty(${t.validity}) and lower_inc(${t.validity}) and not upper_inc(${t.validity})`,
    ),
    index("body_membership_body_idx").on(t.tenantId, t.bodyId),
    index("body_membership_user_idx").on(t.tenantId, t.userId),
    tenantPolicy(),
  ],
).enableRLS();

export const space = pgTable(
  "space",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    name: text("name").notNull(),
    code: text("code"),
    owningOrgUnitId: uuid("owning_org_unit_id").notNull(),
    status: spaceStatus("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "space_pkey", columns: [t.tenantId, t.id] }),
    unique("space_id_unique").on(t.id),
    foreignKey({
      name: "space_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "space_owning_org_unit_fk",
      columns: [t.tenantId, t.owningOrgUnitId],
      foreignColumns: [orgUnit.tenantId, orgUnit.id],
    }).onDelete("restrict"),
    index("space_owning_org_unit_idx").on(t.tenantId, t.owningOrgUnitId),
    tenantPolicy(),
  ],
).enableRLS();

export const configurationVersion = pgTable(
  "configuration_version",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    sequence: integer("sequence").notNull(),
    effectiveFrom: instant("effective_from").notNull(),
    changedBy: uuid("changed_by").notNull(),
    changeReason: text("change_reason").notNull(),
    weakening: boolean("weakening").default(false).notNull(),
    payloadDigest: text("payload_digest").notNull(),
  },
  (t) => [
    primaryKey({ name: "configuration_version_pkey", columns: [t.tenantId, t.id] }),
    unique("configuration_version_id_unique").on(t.id),
    foreignKey({
      name: "configuration_version_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "configuration_version_changed_by_fk",
      columns: [t.tenantId, t.changedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    unique("configuration_version_tenant_sequence_unique").on(t.tenantId, t.sequence),
    check("configuration_version_sequence_positive", sql`${t.sequence} >= 1`),
    index("configuration_version_changed_by_idx").on(t.tenantId, t.changedBy),
    tenantPolicy(),
  ],
).enableRLS();

export const documentType = pgTable(
  "document_type",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rank: integer("rank").notNull(),
    mandatedAuthority: jsonb("mandated_authority").notNull(),
    defaultWorkflowTemplateId: uuid("default_workflow_template_id"),
    defaultReviewRule: jsonb("default_review_rule").notNull(),
    requiresAttestationByDefault: boolean("requires_attestation_by_default")
      .default(false)
      .notNull(),
    mandatedByDocumentVersionId: uuid("mandated_by_document_version_id"),
    status: documentTypeStatus("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "document_type_pkey", columns: [t.tenantId, t.id] }),
    unique("document_type_id_unique").on(t.id),
    foreignKey({
      name: "document_type_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("document_type_tenant_code_unique").on(t.tenantId, t.code),
    unique("document_type_tenant_rank_unique").on(t.tenantId, t.rank),
    tenantPolicy(),
  ],
).enableRLS();

export const informationClassification = pgTable(
  "information_classification",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rank: integer("rank").notNull(),
    handlingInstructions: text("handling_instructions").notNull(),
    externallyDisclosable: boolean("externally_disclosable").notNull(),
    status: informationClassificationStatus("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "information_classification_pkey", columns: [t.tenantId, t.id] }),
    unique("information_classification_id_unique").on(t.id),
    foreignKey({
      name: "information_classification_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("information_classification_tenant_code_unique").on(t.tenantId, t.code),
    unique("information_classification_tenant_rank_unique").on(t.tenantId, t.rank),
    tenantPolicy(),
  ],
).enableRLS();

export const document = pgTable(
  "document",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    documentCode: text("document_code").notNull(),
    canonicalTitle: text("canonical_title").notNull(),
    documentTypeId: uuid("document_type_id").notNull(),
    ownerUserId: uuid("owner_user_id"),
    owningOrgUnitId: uuid("owning_org_unit_id").notNull(),
    spaceId: uuid("space_id"),
    lifecycleStatus: documentLifecycle("lifecycle_status").default("PLANNED").notNull(),
    isGoverningFramework: boolean("is_governing_framework").default(false).notNull(),
    retiredAt: instant("retired_at"),
    retirementReason: text("retirement_reason"),
  },
  (t) => [
    primaryKey({ name: "document_pkey", columns: [t.tenantId, t.id] }),
    unique("document_id_unique").on(t.id),
    foreignKey({
      name: "document_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    unique("document_tenant_code_unique").on(t.tenantId, t.documentCode),
    foreignKey({
      name: "document_type_fk",
      columns: [t.tenantId, t.documentTypeId],
      foreignColumns: [documentType.tenantId, documentType.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_owner_fk",
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_owning_org_unit_fk",
      columns: [t.tenantId, t.owningOrgUnitId],
      foreignColumns: [orgUnit.tenantId, orgUnit.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_space_fk",
      columns: [t.tenantId, t.spaceId],
      foreignColumns: [space.tenantId, space.id],
    }).onDelete("restrict"),
    check(
      "document_retirement_instant_consistent",
      sql`(${t.lifecycleStatus} = 'RETIRED') = (${t.retiredAt} is not null)`,
    ),
    check(
      "document_retirement_reason_required",
      sql`${t.lifecycleStatus} <> 'RETIRED' or nullif(btrim(${t.retirementReason}), '') is not null`,
    ),
    index("document_type_idx").on(t.tenantId, t.documentTypeId),
    index("document_owner_idx").on(t.tenantId, t.ownerUserId),
    index("document_unowned_idx")
      .on(t.tenantId, t.ownerUserId)
      .where(sql`${t.ownerUserId} is null`),
    index("document_owning_org_unit_idx").on(t.tenantId, t.owningOrgUnitId),
    index("document_space_idx").on(t.tenantId, t.spaceId),
    tenantPolicy(),
  ],
).enableRLS();

export const documentVariant = pgTable(
  "document_variant",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    documentId: uuid("document_id").notNull(),
    variantType: variantType("variant_type").notNull(),
    sourceVariantId: uuid("source_variant_id"),
    locale: text("locale"),
    status: text("status").notNull(),
  },
  (t) => [
    primaryKey({ name: "document_variant_pkey", columns: [t.tenantId, t.id] }),
    unique("document_variant_id_unique").on(t.id),
    foreignKey({
      name: "document_variant_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_variant_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_variant_source_fk",
      columns: [t.tenantId, t.sourceVariantId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    check(
      "document_variant_baseline_source",
      sql`(${t.variantType} = 'BASELINE') = (${t.sourceVariantId} is null)`,
    ),
    check(
      "document_variant_translation_locale",
      sql`${t.variantType} <> 'TRANSLATION' or nullif(btrim(${t.locale}), '') is not null`,
    ),
    uniqueIndex("one_baseline_per_document")
      .on(t.tenantId, t.documentId)
      .where(sql`${t.variantType} = 'BASELINE'`),
    index("document_variant_document_idx").on(t.tenantId, t.documentId),
    index("document_variant_source_idx").on(t.tenantId, t.sourceVariantId),
    tenantPolicy(),
  ],
).enableRLS();

export const documentVersion = pgTable(
  "document_version",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").defaultRandom().notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    documentVariantId: uuid("document_variant_id").notNull(),
    versionSequence: integer("version_sequence").notNull(),
    displayLabel: text("display_label"),
    lifecycleState: versionLifecycle("lifecycle_state").default("DRAFT").notNull(),
    documentTypeId: uuid("document_type_id").notNull(),
    title: text("title").notNull(),
    classificationId: uuid("classification_id").notNull(),
    approvedRevisionId: uuid("approved_revision_id"),
    contentDigest: text("content_digest"),
    materiality: materiality("materiality"),
    changeSummary: text("change_summary"),
    approvedAt: instant("approved_at"),
    publishedAt: instant("published_at"),
    effectiveFrom: instant("effective_from"),
    effectiveUntil: instant("effective_until"),
    supersededByVersionId: uuid("superseded_by_version_id"),
    withdrawnAt: instant("withdrawn_at"),
    withdrawalReason: text("withdrawal_reason"),
    configurationVersionId: uuid("configuration_version_id"),
    effectiveRange: tstzrange("effective_range").generatedAlwaysAs(
      sql`case
            when "effective_from" is null then null
            else tstzrange("effective_from", "effective_until", '[)')
          end`,
    ),
  },
  (t) => [
    primaryKey({ name: "document_version_pkey", columns: [t.tenantId, t.id] }),
    unique("document_version_id_unique").on(t.id),
    foreignKey({
      name: "document_version_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_version_variant_fk",
      columns: [t.tenantId, t.documentVariantId],
      foreignColumns: [documentVariant.tenantId, documentVariant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_version_type_fk",
      columns: [t.tenantId, t.documentTypeId],
      foreignColumns: [documentType.tenantId, documentType.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_version_classification_fk",
      columns: [t.tenantId, t.classificationId],
      foreignColumns: [informationClassification.tenantId, informationClassification.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_version_configuration_fk",
      columns: [t.tenantId, t.configurationVersionId],
      foreignColumns: [configurationVersion.tenantId, configurationVersion.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_version_successor_fk",
      columns: [t.tenantId, t.supersededByVersionId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    unique("document_version_variant_sequence_unique").on(
      t.tenantId,
      t.documentVariantId,
      t.versionSequence,
    ),
    check(
      "document_version_withdrawal_reason_required",
      sql`${t.lifecycleState} <> 'WITHDRAWN'
          or nullif(btrim(${t.withdrawalReason}), '') is not null`,
    ),
    check(
      "document_version_effective_interval_start_required",
      sql`${t.effectiveUntil} is null or ${t.effectiveFrom} is not null`,
    ),
    uniqueIndex("one_pre_release_version_per_variant")
      .on(t.tenantId, t.documentVariantId)
      .where(sql`${t.lifecycleState} in ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED')`),
    index("document_version_variant_idx").on(t.tenantId, t.documentVariantId),
    index("document_version_type_idx").on(t.tenantId, t.documentTypeId),
    index("document_version_classification_idx").on(t.tenantId, t.classificationId),
    index("document_version_configuration_idx").on(t.tenantId, t.configurationVersionId),
    index("document_version_successor_idx").on(t.tenantId, t.supersededByVersionId),
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
    foreignKey({
      name: "audit_event_configuration_version_fk",
      columns: [t.tenantId, t.configurationVersionId],
      foreignColumns: [configurationVersion.tenantId, configurationVersion.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_event_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_event_document_variant_fk",
      columns: [t.tenantId, t.documentVariantId],
      foreignColumns: [documentVariant.tenantId, documentVariant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_event_document_version_fk",
      columns: [t.tenantId, t.documentVersionId],
      foreignColumns: [documentVersion.tenantId, documentVersion.id],
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
    index("audit_event_configuration_version_idx").on(t.tenantId, t.configurationVersionId),
    tenantPolicy(),
  ],
).enableRLS();
