import { Client } from "pg";
import { recordConfigurationChange, type AuditTransaction } from "../../domain/src/index.js";
import { migrationDatabaseUrl } from "./migration-connection.js";
import { applyMigrations } from "./runner.js";

export type FixtureKind = "development" | "test";

/**
 * Product-owned values are schema meaning, not tenant data. PostgreSQL enums keep them
 * migration-owned and make the reference loader the ordinary migration chain rather than
 * a second mutable seed path.
 */
export const REFERENCE_ENUM_VALUES = Object.freeze({
  app_user_status: Object.freeze(["INVITED", "ACTIVE", "DEACTIVATED"]),
  credential_kind: Object.freeze(["PASSWORD", "OIDC", "SAML"]),
  document_lifecycle: Object.freeze(["PLANNED", "ACTIVE", "RETIRED"]),
  document_type_status: Object.freeze(["ACTIVE", "RETIRED"]),
  governance_body_status: Object.freeze(["ACTIVE", "DISSOLVED"]),
  governance_seat_role: Object.freeze(["CHAIR", "SECRETARY", "MEMBER"]),
  information_classification_status: Object.freeze(["ACTIVE", "RETIRED"]),
  jurisdiction_level: Object.freeze(["SUPRANATIONAL", "NATIONAL", "REGIONAL", "SECTORAL"]),
  jurisdiction_status: Object.freeze(["ACTIVE", "RETIRED"]),
  legal_entity_status: Object.freeze(["ACTIVE", "DORMANT", "CLOSED"]),
  org_unit_status: Object.freeze(["ACTIVE", "INACTIVE"]),
  space_status: Object.freeze(["ACTIVE", "ARCHIVED"]),
  tenant_status: Object.freeze(["ACTIVE", "SUSPENDED", "CLOSED"]),
  user_group_source: Object.freeze(["LOCAL", "SCIM"]),
  user_group_status: Object.freeze(["ACTIVE", "RETIRED"]),
  variant_type: Object.freeze(["BASELINE", "REPLACEMENT", "SUPPLEMENT", "TRANSLATION"]),
});

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CLOSED_FROM = "2025-01-01T00:00:00.000Z";
const OPEN_FROM = "2026-01-01T00:00:00.000Z";
const SESSION_IDLE_EXPIRY = "2026-01-01T01:00:00.000Z";
const SESSION_ABSOLUTE_EXPIRY = "2026-01-02T00:00:00.000Z";

interface UserFixture {
  id: string;
  displayName: string;
  contactEmail: string;
}

interface CredentialFixture {
  id: string;
  userId: string;
  secretHash: string;
}

interface SessionFixture {
  id: string;
  userId: string;
  tokenHash: string;
}

interface GroupFixture {
  id: string;
  name: string;
}

interface GroupMembershipFixture {
  id: string;
  groupId: string;
  userId: string;
  validFrom: string;
  validUntil: string | null;
}

interface OrgMembershipFixture {
  id: string;
  userId: string;
  validFrom: string;
  validUntil: string | null;
  isPrimary: boolean;
}

interface DocumentTypeFixture {
  id: string;
  code: string;
  name: string;
  rank: number;
  mandatedAuthority: Readonly<Record<string, unknown>>;
  defaultReviewRule: Readonly<Record<string, unknown>>;
  requiresAttestation: boolean;
}

interface ClassificationFixture {
  id: string;
  code: string;
  name: string;
  rank: number;
  handlingInstructions: string;
  externallyDisclosable: boolean;
}

interface DocumentFixture {
  id: string;
  baselineVariantId: string;
  documentCode: string;
  canonicalTitle: string;
  documentTypeId: string;
  ownerUserId: string | null;
  isGoverningFramework: boolean;
}

export interface TenantFixture {
  tenant: Readonly<{
    id: string;
    name: string;
    governanceProfileCode: "ESSENTIAL" | "STANDARD";
  }>;
  users: readonly UserFixture[];
  credentials: readonly CredentialFixture[];
  sessions: readonly SessionFixture[];
  groups: readonly GroupFixture[];
  groupMemberships: readonly GroupMembershipFixture[];
  legalEntity: Readonly<{ id: string; legalName: string }>;
  orgUnit: Readonly<{ id: string; name: string; code: string }>;
  jurisdiction: Readonly<{ id: string; code: string; name: string }>;
  orgMemberships: readonly OrgMembershipFixture[];
  governanceBody: Readonly<{ id: string; code: string; name: string }>;
  bodyMembership: Readonly<{ id: string; userId: string }>;
  space: Readonly<{ id: string; code: string; name: string }>;
  configuration: Readonly<{
    id: string;
    payloadDigest: string;
    requestId: string;
    correlationId: string;
  }>;
  documentTypes: readonly DocumentTypeFixture[];
  classifications: readonly ClassificationFixture[];
  documents: readonly DocumentFixture[];
}

export interface FixtureSet {
  kind: FixtureKind;
  createdAt: string;
  tenants: readonly TenantFixture[];
}

function fixtureId(prefix: "a" | "b" | "d", namespace: number, ordinal: number): string {
  return `${prefix}0000000-0000-0000-${String(namespace).padStart(4, "0")}-${String(ordinal).padStart(12, "0")}`;
}

function essentialTenant(prefix: "a" | "b", name: string): TenantFixture {
  const userId = fixtureId(prefix, 1, 1);
  const groupId = fixtureId(prefix, 4, 1);
  return {
    tenant: {
      id: fixtureId(prefix, 0, 1),
      name,
      governanceProfileCode: "ESSENTIAL",
    },
    users: [
      {
        id: userId,
        displayName: `${name} Administrator`,
        contactEmail: `${prefix}-admin@example.test`,
      },
    ],
    credentials: [
      { id: fixtureId(prefix, 2, 1), userId, secretHash: `fixture-${prefix}-password-hash` },
    ],
    sessions: [{ id: fixtureId(prefix, 3, 1), userId, tokenHash: `fixture-${prefix}-token-hash` }],
    groups: [{ id: groupId, name: "Policy Administrators" }],
    groupMemberships: [
      {
        id: fixtureId(prefix, 5, 1),
        groupId,
        userId,
        validFrom: OPEN_FROM,
        validUntil: null,
      },
    ],
    legalEntity: { id: fixtureId(prefix, 6, 1), legalName: `${name} OÜ` },
    orgUnit: { id: fixtureId(prefix, 7, 1), name: "Head Office", code: "HEAD_OFFICE" },
    jurisdiction: { id: fixtureId(prefix, 8, 1), code: "EE", name: "Estonia" },
    orgMemberships: [
      {
        id: fixtureId(prefix, 9, 1),
        userId,
        validFrom: CLOSED_FROM,
        validUntil: OPEN_FROM,
        isPrimary: true,
      },
      {
        id: fixtureId(prefix, 9, 2),
        userId,
        validFrom: OPEN_FROM,
        validUntil: null,
        isPrimary: true,
      },
    ],
    governanceBody: {
      id: fixtureId(prefix, 10, 1),
      code: "MANAGEMENT_BOARD",
      name: "Management Board",
    },
    bodyMembership: { id: fixtureId(prefix, 11, 1), userId },
    space: { id: fixtureId(prefix, 12, 1), code: "POLICIES", name: "Policies" },
    configuration: {
      id: fixtureId(prefix, 13, 1),
      payloadDigest: `sha256:${prefix}-essential-configuration-v1`,
      requestId: fixtureId(prefix, 16, 1),
      correlationId: fixtureId(prefix, 17, 1),
    },
    documentTypes: [
      {
        id: fixtureId(prefix, 14, 1),
        code: "POLICY",
        name: "Policy",
        rank: 10,
        mandatedAuthority: { MATERIAL: { kind: "NAMED_USER" } },
        defaultReviewRule: { months: 12 },
        requiresAttestation: false,
      },
    ],
    classifications: [
      {
        id: fixtureId(prefix, 15, 1),
        code: "INTERNAL",
        name: "Internal",
        rank: 10,
        handlingInstructions: "For internal use unless separately authorised.",
        externallyDisclosable: false,
      },
    ],
    documents: [
      {
        id: fixtureId(prefix, 18, 1),
        baselineVariantId: fixtureId(prefix, 19, 1),
        documentCode: "POL-001",
        canonicalTitle: `${name} Policy Framework`,
        documentTypeId: fixtureId(prefix, 14, 1),
        ownerUserId: null,
        isGoverningFramework: false,
      },
    ],
  };
}

function developmentTenant(): TenantFixture {
  const prefix = "d" as const;
  const users = [
    {
      id: fixtureId(prefix, 1, 1),
      displayName: "Dana Compliance",
      contactEmail: "dana.compliance@example.test",
    },
    {
      id: fixtureId(prefix, 1, 2),
      displayName: "Eli Policy Owner",
      contactEmail: "eli.owner@example.test",
    },
    {
      id: fixtureId(prefix, 1, 3),
      displayName: "Marta Board Secretary",
      contactEmail: "marta.secretary@example.test",
    },
  ];
  const groups = [
    { id: fixtureId(prefix, 4, 1), name: "Compliance" },
    { id: fixtureId(prefix, 4, 2), name: "Policy Owners" },
  ];
  return {
    tenant: {
      id: fixtureId(prefix, 0, 1),
      name: "PolicyOffice Development",
      governanceProfileCode: "STANDARD",
    },
    users,
    credentials: [
      {
        id: fixtureId(prefix, 2, 1),
        userId: users[0]?.id ?? "",
        secretHash: "fixture-development-password-hash",
      },
    ],
    sessions: [
      {
        id: fixtureId(prefix, 3, 1),
        userId: users[0]?.id ?? "",
        tokenHash: "fixture-development-token-hash",
      },
    ],
    groups,
    groupMemberships: [
      {
        id: fixtureId(prefix, 5, 1),
        groupId: groups[0]?.id ?? "",
        userId: users[0]?.id ?? "",
        validFrom: OPEN_FROM,
        validUntil: null,
      },
      {
        id: fixtureId(prefix, 5, 2),
        groupId: groups[1]?.id ?? "",
        userId: users[1]?.id ?? "",
        validFrom: OPEN_FROM,
        validUntil: null,
      },
    ],
    legalEntity: { id: fixtureId(prefix, 6, 1), legalName: "PolicyOffice Development OÜ" },
    orgUnit: { id: fixtureId(prefix, 7, 1), name: "Compliance", code: "COMPLIANCE" },
    jurisdiction: { id: fixtureId(prefix, 8, 1), code: "EE", name: "Estonia" },
    orgMemberships: [
      {
        id: fixtureId(prefix, 9, 1),
        userId: users[0]?.id ?? "",
        validFrom: CLOSED_FROM,
        validUntil: OPEN_FROM,
        isPrimary: true,
      },
      {
        id: fixtureId(prefix, 9, 2),
        userId: users[0]?.id ?? "",
        validFrom: OPEN_FROM,
        validUntil: null,
        isPrimary: true,
      },
    ],
    governanceBody: {
      id: fixtureId(prefix, 10, 1),
      code: "MANAGEMENT_BOARD",
      name: "Management Board",
    },
    bodyMembership: { id: fixtureId(prefix, 11, 1), userId: users[2]?.id ?? "" },
    space: { id: fixtureId(prefix, 12, 1), code: "POLICIES", name: "Policies" },
    configuration: {
      id: fixtureId(prefix, 13, 1),
      payloadDigest: "sha256:d-standard-configuration-v1",
      requestId: fixtureId(prefix, 16, 1),
      correlationId: fixtureId(prefix, 17, 1),
    },
    documentTypes: [
      {
        id: fixtureId(prefix, 14, 1),
        code: "POLICY",
        name: "Policy",
        rank: 10,
        mandatedAuthority: { MATERIAL: { kind: "GOVERNANCE_BODY" } },
        defaultReviewRule: { months: 12 },
        requiresAttestation: true,
      },
      {
        id: fixtureId(prefix, 14, 2),
        code: "PROCEDURE",
        name: "Procedure",
        rank: 20,
        mandatedAuthority: { MATERIAL: { kind: "NAMED_USER" } },
        defaultReviewRule: { months: 12 },
        requiresAttestation: false,
      },
      {
        id: fixtureId(prefix, 14, 3),
        code: "MANUAL",
        name: "Manual",
        rank: 30,
        mandatedAuthority: { MATERIAL: { kind: "NAMED_USER" } },
        defaultReviewRule: { months: 12 },
        requiresAttestation: false,
      },
    ],
    classifications: [
      {
        id: fixtureId(prefix, 15, 1),
        code: "PUBLIC",
        name: "Public",
        rank: 10,
        handlingInstructions: "Approved for external disclosure.",
        externallyDisclosable: true,
      },
      {
        id: fixtureId(prefix, 15, 2),
        code: "INTERNAL",
        name: "Internal",
        rank: 20,
        handlingInstructions: "For internal use unless separately authorised.",
        externallyDisclosable: false,
      },
      {
        id: fixtureId(prefix, 15, 3),
        code: "CONFIDENTIAL",
        name: "Confidential",
        rank: 30,
        handlingInstructions: "Handle only under an explicit access grant.",
        externallyDisclosable: false,
      },
    ],
    documents: [
      {
        id: fixtureId(prefix, 18, 1),
        baselineVariantId: fixtureId(prefix, 19, 1),
        documentCode: "POL-001",
        canonicalTitle: "Policy Management Policy",
        documentTypeId: fixtureId(prefix, 14, 1),
        ownerUserId: users[1]?.id ?? null,
        isGoverningFramework: false,
      },
    ],
  };
}

/** Build a fresh, deterministic value so callers can compare or safely inspect it. */
export function buildFixtureSet(kind: FixtureKind): FixtureSet {
  return kind === "development"
    ? { kind, createdAt: CREATED_AT, tenants: [developmentTenant()] }
    : {
        kind,
        createdAt: CREATED_AT,
        tenants: [
          essentialTenant("a", "Test Tenant Alpha"),
          essentialTenant("b", "Test Tenant Beta"),
        ],
      };
}

function transaction(sql: Client): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

type ExecutionRole = "migration_role" | "app_role";

async function inRoleTransaction<T>(
  sql: Client,
  role: ExecutionRole,
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await sql.query("begin");
  try {
    await sql.query(`set local role ${role}`);
    const current = await sql.query<{ current_user: string }>("select current_user");
    if (current.rows[0]?.current_user !== role) {
      throw new Error(
        `fixture DML expected ${role}, received ${current.rows[0]?.current_user ?? "none"}`,
      );
    }
    if (tenantId !== null) {
      await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn();
    await sql.query("commit");
    return result;
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function insertTenantRoot(sql: Client, fixture: FixtureSet): Promise<void> {
  await inRoleTransaction(sql, "migration_role", null, async () => {
    for (const item of fixture.tenants) {
      await sql.query(
        `insert into tenant (
           id, name, status, default_timezone, default_locale, residency_profile,
           governance_profile_code, created_at
         ) values ($1, $2, 'ACTIVE', 'Europe/Tallinn', 'en', 'EU', $3, $4)
         on conflict (id) do nothing`,
        [item.tenant.id, item.tenant.name, item.tenant.governanceProfileCode, fixture.createdAt],
      );
    }
  });
}

async function insertIdentity(
  sql: Client,
  fixture: FixtureSet,
  item: TenantFixture,
): Promise<void> {
  for (const user of item.users) {
    await sql.query(
      `insert into app_user (
         tenant_id, id, created_at, updated_at, row_version, display_name,
         contact_email, status, locale, timezone
       ) values ($1, $2, $3, $3, 1, $4, $5, 'ACTIVE', 'en', 'Europe/Tallinn')
       on conflict (tenant_id, id) do nothing`,
      [item.tenant.id, user.id, fixture.createdAt, user.displayName, user.contactEmail],
    );
  }
  for (const credential of item.credentials) {
    await sql.query(
      `insert into user_credential (
         tenant_id, id, created_at, updated_at, row_version, user_id, kind, secret_hash, params
       ) values ($1, $2, $3, $3, 1, $4, 'PASSWORD', $5, '{}'::jsonb)
       on conflict (tenant_id, id) do nothing`,
      [item.tenant.id, credential.id, fixture.createdAt, credential.userId, credential.secretHash],
    );
  }
  for (const session of item.sessions) {
    await sql.query(
      `insert into user_session (
         tenant_id, id, created_at, updated_at, row_version, user_id, token_hash,
         issued_at, idle_expires_at, absolute_expires_at, user_agent_class
       ) values ($1, $2, $3, $3, 1, $4, $5, $3, $6, $7, 'fixture')
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        session.id,
        fixture.createdAt,
        session.userId,
        session.tokenHash,
        SESSION_IDLE_EXPIRY,
        SESSION_ABSOLUTE_EXPIRY,
      ],
    );
  }
  for (const group of item.groups) {
    await sql.query(
      `insert into user_group (
         tenant_id, id, created_at, updated_at, row_version, name, source, status
       ) values ($1, $2, $3, $3, 1, $4, 'LOCAL', 'ACTIVE')
       on conflict (tenant_id, id) do nothing`,
      [item.tenant.id, group.id, fixture.createdAt, group.name],
    );
  }
  for (const membership of item.groupMemberships) {
    await sql.query(
      `insert into group_membership (
         tenant_id, id, created_at, updated_at, row_version, group_id, user_id, validity
       ) values ($1, $2, $3, $3, 1, $4, $5,
                 tstzrange($6::timestamptz, $7::timestamptz, '[)'))
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        membership.id,
        fixture.createdAt,
        membership.groupId,
        membership.userId,
        membership.validFrom,
        membership.validUntil,
      ],
    );
  }
}

async function insertOrganization(
  sql: Client,
  fixture: FixtureSet,
  item: TenantFixture,
): Promise<void> {
  await sql.query(
    `insert into legal_entity (
       tenant_id, id, created_at, updated_at, row_version, legal_name,
       country_of_registration, status
     ) values ($1, $2, $3, $3, 1, $4, 'EE', 'ACTIVE')
     on conflict (tenant_id, id) do nothing`,
    [item.tenant.id, item.legalEntity.id, fixture.createdAt, item.legalEntity.legalName],
  );
  await sql.query(
    `insert into org_unit (
       tenant_id, id, created_at, updated_at, row_version, name, code,
       legal_entity_id, status
     ) values ($1, $2, $3, $3, 1, $4, $5, $6, 'ACTIVE')
     on conflict (tenant_id, id) do nothing`,
    [
      item.tenant.id,
      item.orgUnit.id,
      fixture.createdAt,
      item.orgUnit.name,
      item.orgUnit.code,
      item.legalEntity.id,
    ],
  );
  await sql.query(
    `insert into jurisdiction (
       tenant_id, id, created_at, updated_at, row_version, code, name, level, status
     ) values ($1, $2, $3, $3, 1, $4, $5, 'NATIONAL', 'ACTIVE')
     on conflict (tenant_id, id) do nothing`,
    [
      item.tenant.id,
      item.jurisdiction.id,
      fixture.createdAt,
      item.jurisdiction.code,
      item.jurisdiction.name,
    ],
  );
  for (const membership of item.orgMemberships) {
    await sql.query(
      `insert into org_membership (
         tenant_id, id, created_at, updated_at, row_version, user_id, legal_entity_id,
         org_unit_id, validity, is_primary, jurisdiction_ids
       ) values ($1, $2, $3, $3, 1, $4, $5, $6,
                 tstzrange($7::timestamptz, $8::timestamptz, '[)'), $9, $10::uuid[])
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        membership.id,
        fixture.createdAt,
        membership.userId,
        item.legalEntity.id,
        item.orgUnit.id,
        membership.validFrom,
        membership.validUntil,
        membership.isPrimary,
        [item.jurisdiction.id],
      ],
    );
  }
  await sql.query(
    `insert into governance_body (
       tenant_id, id, created_at, updated_at, row_version, code, name,
       legal_entity_id, quorum_rule, status
     ) values ($1, $2, $3, $3, 1, $4, $5, $6, '{"kind":"MAJORITY"}'::jsonb, 'ACTIVE')
     on conflict (tenant_id, id) do nothing`,
    [
      item.tenant.id,
      item.governanceBody.id,
      fixture.createdAt,
      item.governanceBody.code,
      item.governanceBody.name,
      item.legalEntity.id,
    ],
  );
  await sql.query(
    `insert into body_membership (
       tenant_id, id, created_at, updated_at, row_version, body_id, user_id,
       seat_role, validity
     ) values ($1, $2, $3, $3, 1, $4, $5, 'MEMBER',
               tstzrange($3::timestamptz, null, '[)'))
     on conflict (tenant_id, id) do nothing`,
    [
      item.tenant.id,
      item.bodyMembership.id,
      fixture.createdAt,
      item.governanceBody.id,
      item.bodyMembership.userId,
    ],
  );
  await sql.query(
    `insert into space (
       tenant_id, id, created_at, updated_at, row_version, name, code,
       owning_org_unit_id, status
     ) values ($1, $2, $3, $3, 1, $4, $5, $6, 'ACTIVE')
     on conflict (tenant_id, id) do nothing`,
    [
      item.tenant.id,
      item.space.id,
      fixture.createdAt,
      item.space.name,
      item.space.code,
      item.orgUnit.id,
    ],
  );
}

async function insertConfiguration(sql: Client, item: TenantFixture): Promise<void> {
  const existing = await sql.query<{ id: string }>(
    "select id from configuration_version where id = $1",
    [item.configuration.id],
  );
  if (existing.rows.length === 0) {
    const actor = item.users[0];
    if (!actor) throw new Error(`fixture tenant ${item.tenant.id} has no configuration actor`);
    await recordConfigurationChange(transaction(sql), {
      tenantId: item.tenant.id,
      configurationVersionId: item.configuration.id,
      effectiveFrom: new Date(CREATED_AT),
      changedBy: actor.id,
      changeReason: `Apply copied ${item.tenant.governanceProfileCode} fixture configuration`,
      weakening: false,
      payloadDigest: item.configuration.payloadDigest,
      occurredAt: new Date(CREATED_AT),
      requestId: item.configuration.requestId,
      correlationId: item.configuration.correlationId,
      sourceChannel: "IMPORT",
    });
  }

  for (const documentType of item.documentTypes) {
    await sql.query(
      `insert into document_type (
         tenant_id, id, created_at, updated_at, row_version, code, name, rank,
         mandated_authority, default_review_rule, requires_attestation_by_default, status
       ) values ($1, $2, $3, $3, 1, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'ACTIVE')
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        documentType.id,
        CREATED_AT,
        documentType.code,
        documentType.name,
        documentType.rank,
        JSON.stringify(documentType.mandatedAuthority),
        JSON.stringify(documentType.defaultReviewRule),
        documentType.requiresAttestation,
      ],
    );
  }
  for (const classification of item.classifications) {
    await sql.query(
      `insert into information_classification (
         tenant_id, id, created_at, updated_at, row_version, code, name, rank,
         handling_instructions, externally_disclosable, status
       ) values ($1, $2, $3, $3, 1, $4, $5, $6, $7, $8, 'ACTIVE')
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        classification.id,
        CREATED_AT,
        classification.code,
        classification.name,
        classification.rank,
        classification.handlingInstructions,
        classification.externallyDisclosable,
      ],
    );
  }
}

async function insertDocuments(
  sql: Client,
  fixture: FixtureSet,
  item: TenantFixture,
): Promise<void> {
  for (const document of item.documents) {
    await sql.query(
      `insert into document (
         tenant_id, id, created_at, updated_at, row_version, document_code,
         canonical_title, document_type_id, owner_user_id, owning_org_unit_id,
         space_id, lifecycle_status, is_governing_framework
       ) values ($1, $2, $3, $3, 1, $4, $5, $6, $7, $8, $9, 'PLANNED', $10)
       on conflict (tenant_id, id) do nothing`,
      [
        item.tenant.id,
        document.id,
        fixture.createdAt,
        document.documentCode,
        document.canonicalTitle,
        document.documentTypeId,
        document.ownerUserId,
        item.orgUnit.id,
        item.space.id,
        document.isGoverningFramework,
      ],
    );
    await sql.query(
      `insert into document_variant (
         tenant_id, id, created_at, updated_at, row_version, document_id,
         variant_type, source_variant_id, locale, status
       ) values ($1, $2, $3, $3, 1, $4, 'BASELINE', null, null, 'ACTIVE')
       on conflict (tenant_id, id) do nothing`,
      [item.tenant.id, document.baselineVariantId, fixture.createdAt, document.id],
    );
  }
}

async function insertTenantOwnedRows(
  sql: Client,
  fixture: FixtureSet,
  item: TenantFixture,
): Promise<void> {
  await inRoleTransaction(sql, "app_role", item.tenant.id, async () => {
    await insertIdentity(sql, fixture, item);
    await insertOrganization(sql, fixture, item);
    await insertConfiguration(sql, item);
    await insertDocuments(sql, fixture, item);
  });
}

async function withAdministrativeClient<T>(
  connectionString: string,
  fn: (sql: Client) => Promise<T>,
): Promise<T> {
  const sql = new Client({ connectionString });
  await sql.connect();
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export interface FixtureLoadResult {
  kind: FixtureKind;
  tenantIds: readonly string[];
  executionRoles: readonly ExecutionRole[];
  appliedMigrations: readonly string[];
}

/** Reference values are enum labels and therefore arrive only through migrations. */
export async function loadReferenceData(
  connectionString: string = migrationDatabaseUrl(),
): Promise<readonly string[]> {
  return withAdministrativeClient(connectionString, async (sql) => {
    const result = await applyMigrations(sql);
    return result.applied;
  });
}

/**
 * Load deterministic local fixtures. Tenant roots are provisioned as migration_role;
 * every tenant-owned row is inserted as app_role with a transaction-local tenant context.
 */
export async function loadFixtureSet(
  kind: FixtureKind,
  connectionString: string = migrationDatabaseUrl(),
): Promise<FixtureLoadResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${kind} fixtures are local/CI data and cannot be loaded in production`);
  }
  const fixture = buildFixtureSet(kind);
  return withAdministrativeClient(connectionString, async (sql) => {
    const migrations = await applyMigrations(sql);
    await insertTenantRoot(sql, fixture);
    for (const tenant of fixture.tenants) await insertTenantOwnedRows(sql, fixture, tenant);
    return {
      kind,
      tenantIds: fixture.tenants.map((tenant) => tenant.tenant.id),
      executionRoles: ["migration_role", "app_role"],
      appliedMigrations: migrations.applied,
    };
  });
}

const DELETE_ORDER = [
  "audit_event",
  "tenant_event_sequence",
  "document_variant",
  "document",
  "body_membership",
  "governance_body",
  "space",
  "org_membership",
  "group_membership",
  "user_session",
  "user_credential",
  "user_group",
  "document_type",
  "information_classification",
  "configuration_version",
  "org_unit",
  "jurisdiction",
  "legal_entity",
  "app_user",
] as const;

/** Test cleanup only; production fixture commands never delete governed records. */
export async function removeFixtureSetForTests(
  kind: FixtureKind,
  connectionString: string = migrationDatabaseUrl(),
): Promise<void> {
  const fixture = buildFixtureSet(kind);
  await withAdministrativeClient(connectionString, async (sql) => {
    for (const item of fixture.tenants) {
      await inRoleTransaction(sql, "migration_role", item.tenant.id, async () => {
        for (const table of DELETE_ORDER) {
          await sql.query(`delete from ${table} where tenant_id = $1`, [item.tenant.id]);
        }
      });
    }
    await inRoleTransaction(sql, "migration_role", null, async () => {
      await sql.query("delete from tenant where id = any($1::uuid[])", [
        fixture.tenants.map((tenant) => tenant.tenant.id),
      ]);
    });
  });
}
