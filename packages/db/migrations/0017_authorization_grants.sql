-- POL-023: authorization storage only. These tables are inert until ADR-0003's single
-- evaluator lands; this migration does not decide or enforce application authorization.

create type capability as enum (
  'document.read',
  'document.read_history',
  'document.create',
  'document.edit_draft',
  'document.submit',
  'document.approve',
  'document.publish',
  'document.withdraw',
  'document.cancel_version',
  'document.manage',
  'document.retire',
  'document.restore',
  'document.manage_applicability',
  'document.manage_access',
  'variant.create',
  'review.perform',
  'review.manage',
  'attestation.respond',
  'attestation.manage',
  'waiver.request',
  'waiver.approve',
  'evidence.generate',
  'evidence.download',
  'audit.read',
  'body.act_for',
  'tenant.manage_identity',
  'tenant.manage_configuration',
  'tenant.manage_security',
  'tenant.manage_retention',
  'tenant.break_glass'
);

create type scope_type as enum (
  'TENANT',
  'LEGAL_ENTITY',
  'ORG_UNIT',
  'DOCUMENT',
  'DOCUMENT_VARIANT',
  'DOCUMENT_VERSION',
  'GOVERNANCE_BODY'
);

create type grant_effect as enum ('ALLOW', 'DENY');

comment on type capability is
  'INV-AUTH-016: capabilities are a closed enumeration rather than caller-built strings';
comment on type scope_type is
  'INV-AUTH-015, INV-AUTH-017: authorization follows administrative containment and never Space';
comment on type grant_effect is
  'Stored ALLOW or DENY input for the future ADR-0003 evaluator; this type makes no decision';

create table security_role (
  tenant_id    uuid not null,
  id           uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  row_version  integer not null default 1,
  code         text not null,
  name         text not null,
  capabilities capability[] not null default '{}'::capability[],
  is_system    boolean not null default false,
  constraint security_role_pkey primary key (tenant_id, id),
  constraint security_role_id_unique unique (id),
  constraint security_role_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint security_role_tenant_code_unique unique (tenant_id, code)
);

create table access_grant (
  tenant_id        uuid not null,
  id               uuid not null default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  row_version      integer not null default 1,
  effect           grant_effect not null,
  principal_type   text not null,
  principal_id     uuid not null,
  security_role_id uuid,
  capability       capability,
  scope_type       scope_type not null,
  scope_id         uuid,
  validity         tstzrange not null default tstzrange(now(), null, '[)'),
  granted_by       uuid not null,
  reason           text,
  constraint access_grant_pkey primary key (tenant_id, id),
  constraint access_grant_id_unique unique (id),
  constraint access_grant_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint access_grant_security_role_fk
    foreign key (tenant_id, security_role_id)
    references security_role (tenant_id, id) on delete restrict,
  constraint access_grant_granted_by_fk foreign key (tenant_id, granted_by)
    references app_user (tenant_id, id) on delete restrict,
  constraint access_grant_role_or_capability check (
    num_nonnulls(security_role_id, capability) = 1
  ),
  constraint access_grant_deny_reason_required check (
    effect = 'ALLOW' or reason is not null
  ),
  constraint access_grant_bounded_reason_required check (
    upper_inf(validity) or reason is not null
  ),
  constraint access_grant_scope_id_consistent check (
    (scope_type = 'TENANT') = (scope_id is null)
  )
);

comment on table security_role is
  'Tenant-local capability bundles; inert until the single ADR-0003 evaluator is implemented';
comment on table access_grant is
  'Stored authorization inputs only; this table does not itself enforce application access';
comment on column access_grant.scope_id is
  'Polymorphic by design and intentionally not a foreign key: a dangling scope fails closed, and a later scheduled consistency check reports it';

create trigger enforce_row_version before update on security_role
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on access_grant
  for each row execute function enforce_row_version();

comment on trigger enforce_row_version on security_role is
  'INV-TIME-003: stale role writes conflict instead of overwriting capability bundles';
comment on trigger enforce_row_version on access_grant is
  'INV-TIME-003: stale grant writes conflict instead of overwriting authorization history';

comment on constraint security_role_pkey on security_role is
  'INV-TEN-003: composite identity for a tenant-owned security role';
comment on constraint security_role_id_unique on security_role is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint security_role_tenant_fk on security_role is
  'INV-TEN-003: every security role is anchored to its tenant';
comment on constraint security_role_tenant_code_unique on security_role is
  'A tenant has one role bundle under a stable code; no registered invariant requires code uniqueness';

comment on constraint access_grant_pkey on access_grant is
  'INV-TEN-003: composite identity for a tenant-owned access grant';
comment on constraint access_grant_id_unique on access_grant is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint access_grant_tenant_fk on access_grant is
  'INV-TEN-003: every access grant is anchored to its tenant';
comment on constraint access_grant_security_role_fk on access_grant is
  'INV-TEN-003: a granted role bundle is tenant-contained';
comment on constraint access_grant_granted_by_fk on access_grant is
  'INV-TEN-003: the granting actor is tenant-contained and retained';
comment on constraint access_grant_role_or_capability on access_grant is
  'A grant confers one role bundle or one capability, never both and never neither';
comment on constraint access_grant_deny_reason_required on access_grant is
  'Every explicit deny records its administrative reason';
comment on constraint access_grant_bounded_reason_required on access_grant is
  'Every time-bounded grant records its administrative reason';
comment on constraint access_grant_scope_id_consistent on access_grant is
  'Only tenant scope omits a resource identifier';

alter table security_role enable row level security;
alter table security_role force row level security;
create policy tenant_isolation on security_role
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table access_grant enable row level security;
alter table access_grant force row level security;
create policy tenant_isolation on access_grant
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on security_role is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: security-role isolation fails closed';
comment on policy tenant_isolation on access_grant is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: access-grant isolation fails closed';

grant usage on type capability, scope_type, grant_effect to app_role;
grant select, insert, update on security_role, access_grant to app_role;
revoke delete, truncate on access_grant from app_role;
