import {
  AUTHORIZATION_CAPABILITIES,
  AUTHORIZATION_SCOPE_TYPES,
  GRANT_EFFECTS,
  type AuthorizationDataLoader,
  type AuthorizationFacts,
  type AuthorizationGrant,
  type Capability,
  type GrantEffect,
  type ScopeRef,
} from "../../domain/src/authorization.js";

/** The caller supplies its already-open, tenant-scoped transaction. */
export interface AuthorizationTransaction {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface AuthorizationRow extends Record<string, unknown> {
  resource_found: boolean;
  principal_active: boolean;
  resource_scopes: unknown;
  grants: unknown;
}

const AUTHORIZATION_FACTS_QUERY = `
with recursive resolved_resource (
  scope_type, scope_id, org_unit_id, legal_entity_id, document_id, variant_id
) as (
  select 'TENANT'::scope_type, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid
   where $5::text = 'TENANT'
     and $1::uuid = current_setting('app.tenant_id')::uuid
  union all
  select 'LEGAL_ENTITY'::scope_type, entity.id, null::uuid, entity.id, null::uuid, null::uuid
    from legal_entity entity
   where $5::text = 'LEGAL_ENTITY'
     and entity.tenant_id = $1::uuid
     and entity.id = $6::uuid
  union all
  select 'ORG_UNIT'::scope_type, unit.id, unit.id, unit.legal_entity_id, null::uuid, null::uuid
    from org_unit unit
   where $5::text = 'ORG_UNIT'
     and unit.tenant_id = $1::uuid
     and unit.id = $6::uuid
  union all
  select 'DOCUMENT'::scope_type, document.id, document.owning_org_unit_id,
         unit.legal_entity_id, document.id, null::uuid
    from document
    join org_unit unit
      on unit.tenant_id = document.tenant_id
     and unit.id = document.owning_org_unit_id
   where $5::text = 'DOCUMENT'
     and document.tenant_id = $1::uuid
     and document.id = $6::uuid
  union all
  select 'DOCUMENT_VARIANT'::scope_type, variant.id, document.owning_org_unit_id,
         unit.legal_entity_id, document.id, variant.id
    from document_variant variant
    join document
      on document.tenant_id = variant.tenant_id
     and document.id = variant.document_id
    join org_unit unit
      on unit.tenant_id = document.tenant_id
     and unit.id = document.owning_org_unit_id
   where $5::text = 'DOCUMENT_VARIANT'
     and variant.tenant_id = $1::uuid
     and variant.id = $6::uuid
  union all
  select 'DOCUMENT_VERSION'::scope_type, version.id, document.owning_org_unit_id,
         unit.legal_entity_id, document.id, variant.id
    from document_version version
    join document_variant variant
      on variant.tenant_id = version.tenant_id
     and variant.id = version.document_variant_id
    join document
      on document.tenant_id = variant.tenant_id
     and document.id = variant.document_id
    join org_unit unit
      on unit.tenant_id = document.tenant_id
     and unit.id = document.owning_org_unit_id
   where $5::text = 'DOCUMENT_VERSION'
     and version.tenant_id = $1::uuid
     and version.id = $6::uuid
  union all
  select 'GOVERNANCE_BODY'::scope_type, body.id, null::uuid,
         body.legal_entity_id, null::uuid, null::uuid
    from governance_body body
   where $5::text = 'GOVERNANCE_BODY'
     and body.tenant_id = $1::uuid
     and body.id = $6::uuid
),
org_tree (id, parent_id, legal_entity_id) as (
  select unit.id, unit.parent_org_unit_id, unit.legal_entity_id
    from org_unit unit
    join resolved_resource resource on resource.org_unit_id = unit.id
   where unit.tenant_id = $1::uuid
  union
  select parent.id, parent.parent_org_unit_id, parent.legal_entity_id
    from org_unit parent
    join org_tree child on child.parent_id = parent.id
   where parent.tenant_id = $1::uuid
),
entity_seed (id) as (
  select legal_entity_id from resolved_resource where legal_entity_id is not null
  union
  select legal_entity_id from org_tree
),
entity_tree (id, parent_id) as (
  select entity.id, entity.parent_legal_entity_id
    from legal_entity entity
    join entity_seed seed on seed.id = entity.id
   where entity.tenant_id = $1::uuid
  union
  select parent.id, parent.parent_legal_entity_id
    from legal_entity parent
    join entity_tree child on child.parent_id = parent.id
   where parent.tenant_id = $1::uuid
),
resource_scopes (scope_type, scope_id) as (
  select resource.scope_type, resource.scope_id from resolved_resource resource
  union
  select 'TENANT'::scope_type, null::uuid from resolved_resource
  union
  select 'LEGAL_ENTITY'::scope_type, entity.id from entity_tree entity
  union
  select 'ORG_UNIT'::scope_type, unit.id from org_tree unit
  union
  select 'DOCUMENT'::scope_type, resource.document_id
    from resolved_resource resource where resource.document_id is not null
  union
  select 'DOCUMENT_VARIANT'::scope_type, resource.variant_id
    from resolved_resource resource where resource.variant_id is not null
),
principal_state (active) as (
  select case $2::text
    when 'USER' then exists (
      select 1 from app_user principal
       where principal.tenant_id = $1::uuid
         and principal.id = $3::uuid
         and principal.status = 'ACTIVE'
    )
    when 'GROUP' then exists (
      select 1 from user_group principal
       where principal.tenant_id = $1::uuid
         and principal.id = $3::uuid
         and principal.status = 'ACTIVE'
    )
    else false
  end
),
relevant_principals (principal_type, principal_id) as (
  select $2::text, $3::uuid
  union
  select 'GROUP'::text, membership.group_id
    from group_membership membership
    join user_group principal
      on principal.tenant_id = membership.tenant_id
     and principal.id = membership.group_id
     and principal.status = 'ACTIVE'
   where $2::text = 'USER'
     and membership.tenant_id = $1::uuid
     and membership.user_id = $3::uuid
     and membership.validity @> $4::timestamptz
),
relevant_grants as (
  select grant_row.tenant_id, grant_row.id, grant_row.effect,
         case
           when grant_row.security_role_id is null
             then array[grant_row.capability]::capability[]
           else role.capabilities
         end as capabilities,
         grant_row.scope_type, grant_row.scope_id, grant_row.validity
    from access_grant grant_row
    join relevant_principals principal
      on principal.principal_type = grant_row.principal_type
     and principal.principal_id = grant_row.principal_id
    left join security_role role
      on role.tenant_id = grant_row.tenant_id
     and role.id = grant_row.security_role_id
   where grant_row.tenant_id = $1::uuid
)
select exists(select 1 from resolved_resource) as resource_found,
       (select active from principal_state) as principal_active,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object('type', scope.scope_type::text, 'id', scope.scope_id)
             order by scope.scope_type::text, scope.scope_id
           )
             from resource_scopes scope
         ),
         '[]'::jsonb
       ) as resource_scopes,
       coalesce(
         (
           select jsonb_agg(
             jsonb_build_object(
               'tenantId', grant_row.tenant_id,
               'id', grant_row.id,
               'effect', grant_row.effect::text,
               'capabilities', to_jsonb(grant_row.capabilities),
               'scope', jsonb_build_object(
                 'type', grant_row.scope_type::text,
                 'id', grant_row.scope_id
               ),
               'validity', jsonb_build_object(
                 'from', lower(grant_row.validity),
                 'fromInclusive', lower_inc(grant_row.validity),
                 'until', upper(grant_row.validity),
                 'untilInclusive', upper_inc(grant_row.validity),
                 'empty', isempty(grant_row.validity)
               )
             )
           )
             from relevant_grants grant_row
         ),
         '[]'::jsonb
       ) as grants
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function oneOf<const Choice extends string>(
  value: unknown,
  choices: readonly Choice[],
  field: string,
): Choice {
  const parsed = string(value, field);
  const choice = choices.find((candidate) => candidate === parsed);
  if (choice === undefined) throw new TypeError(`${field} is not supported`);
  return choice;
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === null) return null;
  const parsed = new Date(string(value, field));
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`${field} must be an instant`);
  return parsed;
}

function parseScope(value: unknown, field: string): ScopeRef {
  const input = record(value, field);
  const type = oneOf(input.type, AUTHORIZATION_SCOPE_TYPES, `${field}.type`);
  if (type === "TENANT") {
    if (input.id !== null) throw new TypeError(`${field}.id must be null for TENANT`);
    return Object.freeze({ type, id: null });
  }
  return Object.freeze({ type, id: uuid(input.id, `${field}.id`) });
}

function parseGrant(value: unknown, index: number): AuthorizationGrant {
  const field = `grants[${index}]`;
  const input = record(value, field);
  const validity = record(input.validity, `${field}.validity`);
  return Object.freeze({
    ref: Object.freeze({
      tenantId: uuid(input.tenantId, `${field}.tenantId`),
      id: uuid(input.id, `${field}.id`),
    }),
    effect: oneOf(input.effect, GRANT_EFFECTS, `${field}.effect`) as GrantEffect,
    capabilities: Object.freeze(
      array(input.capabilities, `${field}.capabilities`).map((capability, capabilityIndex) =>
        oneOf(capability, AUTHORIZATION_CAPABILITIES, `${field}.capabilities[${capabilityIndex}]`),
      ),
    ) as readonly Capability[],
    scope: parseScope(input.scope, `${field}.scope`),
    validity: Object.freeze({
      from: optionalDate(validity.from, `${field}.validity.from`),
      fromInclusive: boolean(validity.fromInclusive, `${field}.validity.fromInclusive`),
      until: optionalDate(validity.until, `${field}.validity.until`),
      untilInclusive: boolean(validity.untilInclusive, `${field}.validity.untilInclusive`),
      empty: boolean(validity.empty, `${field}.validity.empty`),
    }),
  });
}

function parseFacts(row: AuthorizationRow): AuthorizationFacts {
  return Object.freeze({
    resourceFound: boolean(row.resource_found, "resource_found"),
    principalActive: boolean(row.principal_active, "principal_active"),
    resourceScopes: Object.freeze(
      array(row.resource_scopes, "resource_scopes").map((scope, index) =>
        parseScope(scope, `resource_scopes[${index}]`),
      ),
    ),
    grants: Object.freeze(
      array(row.grants, "grants").map((grant, index) => parseGrant(grant, index)),
    ),
  });
}

async function loadAuthorizationFacts(
  transaction: AuthorizationTransaction,
  request: Parameters<AuthorizationDataLoader>[0],
): Promise<AuthorizationFacts> {
  const result = await transaction.query<AuthorizationRow>(AUTHORIZATION_FACTS_QUERY, [
    request.tenantId,
    request.principal.type,
    request.principal.id,
    request.instant,
    request.resource.type,
    request.resource.id,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("authorization fact query returned no row");
  return parseFacts(row);
}

/** Bind the only evaluator loader to the caller's RLS-enforced transaction. */
export function authorizationDataLoader(
  transaction: AuthorizationTransaction,
): AuthorizationDataLoader {
  if (typeof transaction?.query !== "function") {
    throw new TypeError("transaction.query must be a function");
  }
  return (request) => loadAuthorizationFacts(transaction, request);
}
