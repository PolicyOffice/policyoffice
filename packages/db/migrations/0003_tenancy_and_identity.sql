-- POL-006: tenancy and identity.
--
-- The administrator that bootstraps a database grants the deliberately non-superuser
-- migration role access to the public schema, then all modelled objects are created as
-- that role. FORCE ROW LEVEL SECURITY therefore binds the owner as well as app_role.
grant usage, create on schema public to migration_role;
set local role migration_role;

create type tenant_status as enum ('ACTIVE', 'SUSPENDED', 'CLOSED');
create type app_user_status as enum ('INVITED', 'ACTIVE', 'DEACTIVATED');
create type credential_kind as enum ('PASSWORD', 'OIDC', 'SAML');
create type user_group_source as enum ('LOCAL', 'SCIM');
create type user_group_status as enum ('ACTIVE', 'RETIRED');

create table tenant (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  status                  tenant_status not null,
  default_timezone        text not null,
  default_locale          text not null,
  residency_profile       text not null,
  governance_profile_code text,
  created_at              timestamptz not null default now()
);

comment on column tenant.governance_profile_code is
  'INV-CFG-002: provenance of copied configuration, never a live profile link';

create table app_user (
  tenant_id           uuid not null,
  id                  uuid not null default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  row_version         integer not null default 1,
  external_identity_id text,
  display_name        text not null,
  contact_email       text not null,
  status              app_user_status not null,
  locale              text,
  timezone            text,
  deactivated_at      timestamptz,
  constraint app_user_pkey primary key (tenant_id, id),
  constraint app_user_id_unique unique (id),
  constraint app_user_tenant_fk foreign key (tenant_id) references tenant (id) on delete restrict,
  constraint app_user_external_identity_unique unique (tenant_id, external_identity_id),
  constraint app_user_deactivation_consistent check (
    (status = 'DEACTIVATED' and deactivated_at is not null)
    or (status <> 'DEACTIVATED' and deactivated_at is null)
  )
);

create unique index app_user_tenant_email_unique
  on app_user (tenant_id, lower(contact_email));

create table user_credential (
  tenant_id   uuid not null,
  id          uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1,
  user_id     uuid not null,
  kind        credential_kind not null,
  secret_hash text not null,
  params      jsonb not null default '{}'::jsonb,
  rotated_at  timestamptz,
  constraint user_credential_pkey primary key (tenant_id, id),
  constraint user_credential_id_unique unique (id),
  constraint user_credential_tenant_fk foreign key (tenant_id) references tenant (id) on delete restrict,
  constraint user_credential_user_fk foreign key (tenant_id, user_id)
    references app_user (tenant_id, id) on delete restrict
);

create table user_session (
  tenant_id          uuid not null,
  id                 uuid not null default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  row_version        integer not null default 1,
  user_id            uuid not null,
  token_hash         text not null,
  issued_at          timestamptz not null,
  idle_expires_at    timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at         timestamptz,
  user_agent_class   text not null,
  constraint user_session_pkey primary key (tenant_id, id),
  constraint user_session_id_unique unique (id),
  constraint user_session_tenant_fk foreign key (tenant_id) references tenant (id) on delete restrict,
  constraint user_session_user_fk foreign key (tenant_id, user_id)
    references app_user (tenant_id, id) on delete restrict
);

create table user_group (
  tenant_id   uuid not null,
  id          uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1,
  name        text not null,
  source      user_group_source not null,
  external_id text,
  status      user_group_status not null,
  constraint user_group_pkey primary key (tenant_id, id),
  constraint user_group_id_unique unique (id),
  constraint user_group_tenant_fk foreign key (tenant_id) references tenant (id) on delete restrict
);

create unique index user_group_tenant_name_unique
  on user_group (tenant_id, lower(name));

create table group_membership (
  tenant_id   uuid not null,
  id          uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version integer not null default 1,
  group_id    uuid not null,
  user_id     uuid not null,
  validity    tstzrange not null,
  constraint group_membership_pkey primary key (tenant_id, id),
  constraint group_membership_id_unique unique (id),
  constraint group_membership_tenant_fk foreign key (tenant_id) references tenant (id) on delete restrict,
  constraint group_membership_group_fk foreign key (tenant_id, group_id)
    references user_group (tenant_id, id) on delete restrict,
  constraint group_membership_user_fk foreign key (tenant_id, user_id)
    references app_user (tenant_id, id) on delete restrict,
  constraint group_membership_validity_half_open check (
    not isempty(validity) and lower_inc(validity) and not upper_inc(validity)
  )
);

-- INV-TEN-003: tenant-owned primary and foreign keys make cross-tenant references
-- structurally unrepresentable. The IDs live on the constraints, not only in this file.
comment on constraint app_user_pkey on app_user is
  'INV-TEN-003: composite identity for a tenant-owned row';
comment on constraint app_user_tenant_fk on app_user is
  'INV-TEN-003: every tenant-owned row is anchored to its tenant';
comment on constraint user_credential_pkey on user_credential is
  'INV-TEN-003: composite identity for a tenant-owned row';
comment on constraint user_credential_tenant_fk on user_credential is
  'INV-TEN-003: every tenant-owned row is anchored to its tenant';
comment on constraint user_credential_user_fk on user_credential is
  'INV-TEN-003: tenant_id is carried through the user reference';
comment on constraint user_session_pkey on user_session is
  'INV-TEN-003: composite identity for a tenant-owned row';
comment on constraint user_session_tenant_fk on user_session is
  'INV-TEN-003: every tenant-owned row is anchored to its tenant';
comment on constraint user_session_user_fk on user_session is
  'INV-TEN-003: tenant_id is carried through the user reference';
comment on constraint user_group_pkey on user_group is
  'INV-TEN-003: composite identity for a tenant-owned row';
comment on constraint user_group_tenant_fk on user_group is
  'INV-TEN-003: every tenant-owned row is anchored to its tenant';
comment on constraint group_membership_pkey on group_membership is
  'INV-TEN-003: composite identity for a tenant-owned row';
comment on constraint group_membership_tenant_fk on group_membership is
  'INV-TEN-003: every tenant-owned row is anchored to its tenant';
comment on constraint group_membership_group_fk on group_membership is
  'INV-TEN-003: tenant_id is carried through the group reference';
comment on constraint group_membership_user_fk on group_membership is
  'INV-TEN-003: tenant_id is carried through the user reference';
comment on constraint app_user_deactivation_consistent on app_user is
  'INV-AUTH-014: a deactivated principal records when authority ended';
comment on constraint group_membership_validity_half_open on group_membership is
  'INV-TIME-005: membership validity uses a non-empty half-open interval';

-- INV-TIME-003: every update must present the exact next row version. A caller that
-- loaded version 1 and later tries to write version 2 loses to an intervening writer
-- instead of silently overwriting it.
create function enforce_row_version() returns trigger
language plpgsql
as $$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'stale row version for %.%: expected %, received %',
      tg_table_schema, tg_table_name, old.row_version + 1, new.row_version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function enforce_row_version() is
  'INV-TIME-003: stale writes conflict rather than overwrite tenant-owned rows';

create trigger enforce_row_version before update on app_user
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on user_credential
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on user_session
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on user_group
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on group_membership
  for each row execute function enforce_row_version();

create function revoke_sessions_on_deactivation() returns trigger
language plpgsql
as $$
begin
  if new.status = 'DEACTIVATED' and old.status <> 'DEACTIVATED' then
    new.deactivated_at := coalesce(new.deactivated_at, now());
    delete from user_session
      where tenant_id = new.tenant_id and user_id = new.id;
  end if;
  return new;
end;
$$;

comment on function revoke_sessions_on_deactivation() is
  'INV-AUTH-014: deactivation immediately removes every server-side session';

create trigger revoke_sessions_on_deactivation before update of status on app_user
  for each row execute function revoke_sessions_on_deactivation();

-- INV-TEN-001/002/004/005: the policy is below every query surface. USING filters reads;
-- PostgreSQL reuses it as WITH CHECK, so cross-tenant writes fail closed too.
alter table app_user enable row level security;
alter table app_user force row level security;
create policy tenant_isolation on app_user
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table user_credential enable row level security;
alter table user_credential force row level security;
create policy tenant_isolation on user_credential
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table user_session enable row level security;
alter table user_session force row level security;
create policy tenant_isolation on user_session
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table user_group enable row level security;
alter table user_group force row level security;
create policy tenant_isolation on user_group
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table group_membership enable row level security;
alter table group_membership force row level security;
create policy tenant_isolation on group_membership
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on app_user is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on user_credential is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on user_session is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on user_group is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on group_membership is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';

grant usage on schema public to app_role;
grant usage on type tenant_status, app_user_status, credential_kind,
  user_group_source, user_group_status to app_role;
grant select, insert, update on app_user, user_credential, user_session,
  user_group, group_membership to app_role;
grant delete on user_session to app_role;

-- INV-AUTH-014: historical attribution survives deactivation. Only sessions are deleted.
revoke delete on app_user, user_credential, user_group, group_membership from app_role;
revoke all on tenant from app_role;

-- Return the migration runner to its login role before it writes the checksum ledger.
-- On production connections that already authenticate as migration_role this is a no-op.
reset role;
