-- POL-008: organisation structures and point-in-time memberships.
--
-- This migration is intentionally schema-complete and behaviour-minimal. Organisation
-- mutations do not emit audit events until the service commands land; the permanent
-- catalog names reserved by the issue are recorded in the pull request.

create type legal_entity_status as enum ('ACTIVE', 'DORMANT', 'CLOSED');
create type org_unit_status as enum ('ACTIVE', 'INACTIVE');
create type jurisdiction_level as enum ('SUPRANATIONAL', 'NATIONAL', 'REGIONAL', 'SECTORAL');
create type jurisdiction_status as enum ('ACTIVE', 'RETIRED');
create type governance_body_status as enum ('ACTIVE', 'DISSOLVED');
create type governance_seat_role as enum ('CHAIR', 'SECRETARY', 'MEMBER');
create type space_status as enum ('ACTIVE', 'ARCHIVED');

create table legal_entity (
  tenant_id                 uuid not null,
  id                        uuid not null default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  row_version               integer not null default 1,
  legal_name                text not null,
  registration_number       text,
  country_of_registration   text,
  parent_legal_entity_id    uuid,
  status                    legal_entity_status not null,
  closed_at                 timestamptz,
  constraint legal_entity_pkey primary key (tenant_id, id),
  constraint legal_entity_id_unique unique (id),
  constraint legal_entity_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint legal_entity_parent_fk foreign key (tenant_id, parent_legal_entity_id)
    references legal_entity (tenant_id, id) on delete restrict,
  constraint legal_entity_not_own_parent check (id <> parent_legal_entity_id),
  constraint legal_entity_closure_consistent check (
    (status = 'CLOSED' and closed_at is not null)
    or (status <> 'CLOSED' and closed_at is null)
  )
);

create table org_unit (
  tenant_id          uuid not null,
  id                 uuid not null default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  row_version        integer not null default 1,
  name               text not null,
  code               text,
  legal_entity_id    uuid not null,
  parent_org_unit_id uuid,
  status             org_unit_status not null,
  closed_at          timestamptz,
  constraint org_unit_pkey primary key (tenant_id, id),
  constraint org_unit_id_unique unique (id),
  constraint org_unit_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint org_unit_legal_entity_fk foreign key (tenant_id, legal_entity_id)
    references legal_entity (tenant_id, id) on delete restrict,
  constraint org_unit_parent_fk foreign key (tenant_id, parent_org_unit_id)
    references org_unit (tenant_id, id) on delete restrict,
  constraint org_unit_not_own_parent check (id <> parent_org_unit_id),
  constraint org_unit_closure_consistent check (
    (status = 'INACTIVE' and closed_at is not null)
    or (status <> 'INACTIVE' and closed_at is null)
  )
);

create table jurisdiction (
  tenant_id   uuid not null,
  id          uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1,
  code        text not null,
  name        text not null,
  level       jurisdiction_level not null,
  status      jurisdiction_status not null,
  constraint jurisdiction_pkey primary key (tenant_id, id),
  constraint jurisdiction_id_unique unique (id),
  constraint jurisdiction_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint jurisdiction_tenant_code_unique unique (tenant_id, code)
);

create table org_membership (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1,
  user_id         uuid not null,
  legal_entity_id uuid not null,
  org_unit_id     uuid not null,
  validity        tstzrange not null,
  is_primary      boolean not null default false,
  jurisdiction_ids uuid[] not null default '{}'::uuid[],
  constraint org_membership_pkey primary key (tenant_id, id),
  constraint org_membership_id_unique unique (id),
  constraint org_membership_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint org_membership_user_fk foreign key (tenant_id, user_id)
    references app_user (tenant_id, id) on delete restrict,
  constraint org_membership_legal_entity_fk foreign key (tenant_id, legal_entity_id)
    references legal_entity (tenant_id, id) on delete restrict,
  constraint org_membership_org_unit_fk foreign key (tenant_id, org_unit_id)
    references org_unit (tenant_id, id) on delete restrict,
  constraint org_membership_validity_half_open check (
    not isempty(validity) and lower_inc(validity) and not upper_inc(validity)
  ),
  constraint org_membership_no_overlap exclude using gist (
    tenant_id with =,
    user_id with =,
    org_unit_id with =,
    validity with &&
  )
);

create table governance_body (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1,
  code            text not null,
  name            text not null,
  legal_entity_id uuid not null,
  parent_body_id  uuid,
  quorum_rule     jsonb not null default '{}'::jsonb,
  status          governance_body_status not null,
  closed_at       timestamptz,
  constraint governance_body_pkey primary key (tenant_id, id),
  constraint governance_body_id_unique unique (id),
  constraint governance_body_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint governance_body_tenant_code_unique unique (tenant_id, code),
  constraint governance_body_legal_entity_fk foreign key (tenant_id, legal_entity_id)
    references legal_entity (tenant_id, id) on delete restrict,
  constraint governance_body_parent_fk foreign key (tenant_id, parent_body_id)
    references governance_body (tenant_id, id) on delete restrict,
  constraint governance_body_not_own_parent check (id <> parent_body_id),
  constraint governance_body_closure_consistent check (
    (status = 'DISSOLVED' and closed_at is not null)
    or (status <> 'DISSOLVED' and closed_at is null)
  )
);

create table body_membership (
  tenant_id   uuid not null,
  id          uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1,
  body_id     uuid not null,
  user_id     uuid not null,
  seat_role   governance_seat_role,
  validity    tstzrange not null,
  constraint body_membership_pkey primary key (tenant_id, id),
  constraint body_membership_id_unique unique (id),
  constraint body_membership_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint body_membership_body_fk foreign key (tenant_id, body_id)
    references governance_body (tenant_id, id) on delete restrict,
  constraint body_membership_user_fk foreign key (tenant_id, user_id)
    references app_user (tenant_id, id) on delete restrict,
  constraint body_membership_validity_half_open check (
    not isempty(validity) and lower_inc(validity) and not upper_inc(validity)
  )
);

create table space (
  tenant_id         uuid not null,
  id                uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  row_version       integer not null default 1,
  name              text not null,
  code              text,
  owning_org_unit_id uuid not null,
  status            space_status not null,
  constraint space_pkey primary key (tenant_id, id),
  constraint space_id_unique unique (id),
  constraint space_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint space_owning_org_unit_fk foreign key (tenant_id, owning_org_unit_id)
    references org_unit (tenant_id, id) on delete restrict
);

-- Every foreign-key lookup starts with tenant_id. The membership GiST index supports
-- point-in-time resolution without weakening the no-overlap exclusion above.
create index legal_entity_parent_idx
  on legal_entity (tenant_id, parent_legal_entity_id);
create index org_unit_legal_entity_idx
  on org_unit (tenant_id, legal_entity_id);
create index org_unit_parent_idx
  on org_unit (tenant_id, parent_org_unit_id);
create index org_membership_user_validity_idx
  on org_membership using gist (tenant_id, user_id, validity);
create index org_membership_legal_entity_idx
  on org_membership (tenant_id, legal_entity_id);
create index org_membership_org_unit_idx
  on org_membership (tenant_id, org_unit_id);
create index governance_body_legal_entity_idx
  on governance_body (tenant_id, legal_entity_id);
create index governance_body_parent_idx
  on governance_body (tenant_id, parent_body_id);
create index body_membership_body_idx
  on body_membership (tenant_id, body_id);
create index body_membership_user_idx
  on body_membership (tenant_id, user_id);
create index space_owning_org_unit_idx
  on space (tenant_id, owning_org_unit_id);

-- INV-ORG-001: self checks catch the smallest error cheaply; this trigger follows the
-- proposed parent chain for both insert and update and refuses longer cycles.
create function assert_acyclic_parent() returns trigger
language plpgsql
as $$
declare
  parent_column text := tg_argv[0];
  ancestor_id uuid;
  visited uuid[] := array[new.id];
begin
  ancestor_id := (to_jsonb(new) ->> parent_column)::uuid;
  if ancestor_id is null then
    return new;
  end if;

  -- Serialize parent changes per tenant and hierarchy. Without this lock, two writers
  -- could each validate against the other's pre-commit tree and create a cycle together.
  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || tg_table_name, 0)
  );

  while ancestor_id is not null loop
    if ancestor_id = any(visited) then
      raise exception 'cycle in %.% through %', tg_table_schema, tg_table_name, ancestor_id
        using errcode = '23514', constraint = tg_table_name || '_acyclic';
    end if;

    visited := array_append(visited, ancestor_id);
    execute format(
      'select %I from %I.%I where tenant_id = $1 and id = $2',
      parent_column, tg_table_schema, tg_table_name
    )
      into ancestor_id
      using new.tenant_id, ancestor_id;
  end loop;

  return new;
end;
$$;

comment on function assert_acyclic_parent() is
  'INV-ORG-001: legal-entity and org-unit parent chains are tenant-contained DAGs';

create trigger legal_entity_acyclic
  before insert or update of tenant_id, id, parent_legal_entity_id on legal_entity
  for each row execute function assert_acyclic_parent('parent_legal_entity_id');
create trigger org_unit_acyclic
  before insert or update of tenant_id, id, parent_org_unit_id on org_unit
  for each row execute function assert_acyclic_parent('parent_org_unit_id');

comment on trigger legal_entity_acyclic on legal_entity is
  'INV-ORG-001: legal-entity ancestry cannot contain a cycle';
comment on trigger org_unit_acyclic on org_unit is
  'INV-ORG-001: org-unit ancestry cannot contain a cycle';

-- uuid[] cannot carry a composite foreign key. Validate every explicit jurisdiction
-- against the membership tenant so the denormalised shape cannot smuggle a foreign row.
create function assert_org_membership_jurisdictions() returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from unnest(new.jurisdiction_ids) as requested(id)
      left join jurisdiction j
        on j.tenant_id = new.tenant_id and j.id = requested.id
     where j.id is null
  ) then
    raise exception 'org membership contains a jurisdiction outside its tenant'
      using errcode = '23503', constraint = 'org_membership_jurisdiction_tenant_fk';
  end if;
  return new;
end;
$$;

comment on function assert_org_membership_jurisdictions() is
  'INV-TEN-003, INV-ORG-004: every explicit jurisdiction belongs to the membership tenant';

create trigger enforce_org_membership_jurisdictions
  before insert or update of tenant_id, jurisdiction_ids on org_membership
  for each row execute function assert_org_membership_jurisdictions();

comment on trigger enforce_org_membership_jurisdictions on org_membership is
  'INV-TEN-003, INV-ORG-004: explicit jurisdiction references are tenant-contained';

-- INV-ORG-002: an open membership may be ended, but neither an ended row nor any of its
-- identifying facts may be rewritten. Corrections therefore close and append.
create function protect_org_membership_history() returns trigger
language plpgsql
as $$
begin
  if not upper_inf(old.validity) then
    raise exception 'ended org memberships are immutable'
      using errcode = '55000';
  end if;

  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.legal_entity_id is distinct from old.legal_entity_id
     or new.org_unit_id is distinct from old.org_unit_id
     or new.is_primary is distinct from old.is_primary
     or new.jurisdiction_ids is distinct from old.jurisdiction_ids
     or lower(new.validity) is distinct from lower(old.validity)
     or lower_inc(new.validity) is distinct from lower_inc(old.validity)
     or upper_inf(new.validity) then
    raise exception 'an open org membership may only be ended'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

comment on function protect_org_membership_history() is
  'INV-ORG-002: corrections close an open interval and append a new membership fact';

create trigger protect_org_membership_history
  before update on org_membership
  for each row execute function protect_org_membership_history();

comment on trigger protect_org_membership_history on org_membership is
  'INV-ORG-002: an ended membership cannot be rewritten';

create trigger enforce_row_version before update on legal_entity
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on org_unit
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on jurisdiction
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on org_membership
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on governance_body
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on body_membership
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on space
  for each row execute function enforce_row_version();

-- Constraint comments make the database enforcement map inspectable. Identity and
-- tenant anchoring comments include INV-TEN-003 so the universal gate keeps working.
comment on constraint legal_entity_pkey on legal_entity is
  'INV-TEN-003: composite identity for a tenant-owned legal entity';
comment on constraint legal_entity_id_unique on legal_entity is
  'INV-TEN-003: globally addressable IDs support composite tenant references';
comment on constraint legal_entity_tenant_fk on legal_entity is
  'INV-TEN-003: every legal entity is anchored to its tenant';
comment on constraint legal_entity_parent_fk on legal_entity is
  'INV-TEN-003, INV-ORG-001: parentage remains inside one tenant';
comment on constraint legal_entity_not_own_parent on legal_entity is
  'INV-ORG-001: a legal entity cannot parent itself';
comment on constraint legal_entity_closure_consistent on legal_entity is
  'INV-ORG-003: closure preserves the entity and records its closing instant';

comment on constraint org_unit_pkey on org_unit is
  'INV-TEN-003: composite identity for a tenant-owned org unit';
comment on constraint org_unit_id_unique on org_unit is
  'INV-TEN-003: globally addressable IDs support composite tenant references';
comment on constraint org_unit_tenant_fk on org_unit is
  'INV-TEN-003: every org unit is anchored to its tenant';
comment on constraint org_unit_legal_entity_fk on org_unit is
  'INV-TEN-003, INV-ORG-003: the owning legal entity is tenant-contained and retained';
comment on constraint org_unit_parent_fk on org_unit is
  'INV-TEN-003, INV-ORG-001: parentage remains inside one tenant';
comment on constraint org_unit_not_own_parent on org_unit is
  'INV-ORG-001: an org unit cannot parent itself';
comment on constraint org_unit_closure_consistent on org_unit is
  'INV-ORG-003: inactivation preserves the unit and records its closing instant';

comment on constraint jurisdiction_pkey on jurisdiction is
  'INV-TEN-003: composite identity for a tenant-owned jurisdiction';
comment on constraint jurisdiction_id_unique on jurisdiction is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint jurisdiction_tenant_fk on jurisdiction is
  'INV-TEN-003: every jurisdiction is anchored to its tenant';
comment on constraint jurisdiction_tenant_code_unique on jurisdiction is
  'INV-ORG-004: an explicit tenant jurisdiction has one stable code';

comment on constraint org_membership_pkey on org_membership is
  'INV-TEN-003: composite identity for a tenant-owned membership';
comment on constraint org_membership_id_unique on org_membership is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint org_membership_tenant_fk on org_membership is
  'INV-TEN-003: every membership is anchored to its tenant';
comment on constraint org_membership_user_fk on org_membership is
  'INV-TEN-003, INV-ORG-002: the historical principal is tenant-contained and retained';
comment on constraint org_membership_legal_entity_fk on org_membership is
  'INV-TEN-003, INV-ORG-003: the historical legal entity is tenant-contained and retained';
comment on constraint org_membership_org_unit_fk on org_membership is
  'INV-TEN-003, INV-ORG-003: the historical org unit is tenant-contained and retained';
comment on constraint org_membership_validity_half_open on org_membership is
  'INV-TIME-005, INV-ORG-002: membership validity is a non-empty half-open interval';
comment on constraint org_membership_no_overlap on org_membership is
  'INV-TIME-005, INV-ORG-002: one user and org unit cannot overlap itself';

comment on constraint governance_body_pkey on governance_body is
  'INV-TEN-003: composite identity for a tenant-owned governance body';
comment on constraint governance_body_id_unique on governance_body is
  'INV-TEN-003: globally addressable IDs support composite tenant references';
comment on constraint governance_body_tenant_fk on governance_body is
  'INV-TEN-003: every governance body is anchored to its tenant';
comment on constraint governance_body_tenant_code_unique on governance_body is
  'INV-ORG-005: a governance body has one stable tenant-local code';
comment on constraint governance_body_legal_entity_fk on governance_body is
  'INV-TEN-003, INV-ORG-005: every body belongs to exactly one tenant-contained entity';
comment on constraint governance_body_parent_fk on governance_body is
  'INV-TEN-003, INV-ORG-005: a parent body remains inside the same tenant';
comment on constraint governance_body_not_own_parent on governance_body is
  'INV-ORG-005: a governance body cannot parent itself';
comment on constraint governance_body_closure_consistent on governance_body is
  'INV-ORG-003, INV-ORG-005: dissolution preserves the body and records its instant';

comment on constraint body_membership_pkey on body_membership is
  'INV-TEN-003: composite identity for a tenant-owned body membership';
comment on constraint body_membership_id_unique on body_membership is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint body_membership_tenant_fk on body_membership is
  'INV-TEN-003: every body membership is anchored to its tenant';
comment on constraint body_membership_body_fk on body_membership is
  'INV-TEN-003, INV-ORG-005: the governance body is tenant-contained and retained';
comment on constraint body_membership_user_fk on body_membership is
  'INV-TEN-003, INV-ORG-005: the seated principal is tenant-contained and retained';
comment on constraint body_membership_validity_half_open on body_membership is
  'INV-TIME-005, INV-ORG-005: body service uses a non-empty half-open interval';

comment on constraint space_pkey on space is
  'INV-TEN-003: composite identity for a tenant-owned administrative space';
comment on constraint space_id_unique on space is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint space_tenant_fk on space is
  'INV-TEN-003: every administrative space is anchored to its tenant';
comment on constraint space_owning_org_unit_fk on space is
  'INV-TEN-003, INV-AUTH-015, INV-APL-010: ownership is administrative, never authoritative';

-- INV-TEN-001/002/004/005: isolation is enforced under the application role and the
-- deliberately non-bypassing migration owner alike.
alter table legal_entity enable row level security;
alter table legal_entity force row level security;
create policy tenant_isolation on legal_entity
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table org_unit enable row level security;
alter table org_unit force row level security;
create policy tenant_isolation on org_unit
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table jurisdiction enable row level security;
alter table jurisdiction force row level security;
create policy tenant_isolation on jurisdiction
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table org_membership enable row level security;
alter table org_membership force row level security;
create policy tenant_isolation on org_membership
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table governance_body enable row level security;
alter table governance_body force row level security;
create policy tenant_isolation on governance_body
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table body_membership enable row level security;
alter table body_membership force row level security;
create policy tenant_isolation on body_membership
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table space enable row level security;
alter table space force row level security;
create policy tenant_isolation on space
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on legal_entity is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on org_unit is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on jurisdiction is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on org_membership is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on governance_body is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on body_membership is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on space is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';

grant usage on type legal_entity_status, org_unit_status, jurisdiction_level,
  jurisdiction_status, governance_body_status, governance_seat_role, space_status
  to app_role;
grant select, insert, update on legal_entity, org_unit, jurisdiction, org_membership,
  governance_body, body_membership, space to app_role;
grant delete on legal_entity, org_unit, jurisdiction, governance_body, body_membership,
  space to app_role;

-- INV-ORG-002: membership facts are ended and appended, never removed.
revoke delete, truncate on org_membership from app_role;
