-- POL-012: stable document identity and its mandatory baseline variant.

create type document_lifecycle as enum ('PLANNED', 'ACTIVE', 'RETIRED');
create type variant_type as enum ('BASELINE', 'REPLACEMENT', 'SUPPLEMENT', 'TRANSLATION');

create table document (
  tenant_id               uuid not null,
  id                      uuid not null default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  row_version             integer not null default 1,
  document_code           text not null,
  canonical_title         text not null,
  document_type_id        uuid not null,
  owner_user_id           uuid,
  owning_org_unit_id      uuid not null,
  space_id                uuid,
  lifecycle_status        document_lifecycle not null default 'PLANNED',
  is_governing_framework  boolean not null default false,
  retired_at              timestamptz,
  retirement_reason       text,
  constraint document_pkey primary key (tenant_id, id),
  constraint document_id_unique unique (id),
  constraint document_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint document_tenant_code_unique unique (tenant_id, document_code),
  constraint document_type_fk foreign key (tenant_id, document_type_id)
    references document_type (tenant_id, id) on delete restrict,
  constraint document_owner_fk foreign key (tenant_id, owner_user_id)
    references app_user (tenant_id, id) on delete restrict,
  constraint document_owning_org_unit_fk foreign key (tenant_id, owning_org_unit_id)
    references org_unit (tenant_id, id) on delete restrict,
  constraint document_space_fk foreign key (tenant_id, space_id)
    references space (tenant_id, id) on delete restrict,
  constraint document_retirement_instant_consistent check (
    (lifecycle_status = 'RETIRED') = (retired_at is not null)
  ),
  constraint document_retirement_reason_required check (
    lifecycle_status <> 'RETIRED'
    or nullif(btrim(retirement_reason), '') is not null
  )
);

create table document_variant (
  tenant_id         uuid not null,
  id                uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  row_version       integer not null default 1,
  document_id       uuid not null,
  variant_type      variant_type not null,
  source_variant_id uuid,
  locale            text,
  status            text not null,
  constraint document_variant_pkey primary key (tenant_id, id),
  constraint document_variant_id_unique unique (id),
  constraint document_variant_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint document_variant_document_fk foreign key (tenant_id, document_id)
    references document (tenant_id, id) on delete restrict,
  constraint document_variant_source_fk foreign key (tenant_id, source_variant_id)
    references document_variant (tenant_id, id) on delete restrict,
  constraint document_variant_baseline_source check (
    (variant_type = 'BASELINE') = (source_variant_id is null)
  ),
  constraint document_variant_translation_locale check (
    variant_type <> 'TRANSLATION' or nullif(btrim(locale), '') is not null
  )
);

create unique index one_baseline_per_document
  on document_variant (tenant_id, document_id)
  where variant_type = 'BASELINE';

create index document_type_idx on document (tenant_id, document_type_id);
create index document_owner_idx on document (tenant_id, owner_user_id);
create index document_unowned_idx on document (tenant_id, owner_user_id)
  where owner_user_id is null;
create index document_owning_org_unit_idx on document (tenant_id, owning_org_unit_id);
create index document_space_idx on document (tenant_id, space_id);
create index document_variant_document_idx on document_variant (tenant_id, document_id);
create index document_variant_source_idx on document_variant (tenant_id, source_variant_id);

create function enforce_document_lifecycle_transition() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_status <> 'PLANNED' then
      raise exception using
        errcode = '23514',
        constraint = 'document_lifecycle_transition',
        message = 'a document must be created as PLANNED';
    end if;
  elsif new.lifecycle_status is distinct from old.lifecycle_status
        and not (old.lifecycle_status = 'PLANNED' and new.lifecycle_status = 'RETIRED') then
    raise exception using
      errcode = '23514',
      constraint = 'document_lifecycle_transition',
      message = format(
        'document lifecycle transition from %s to %s is not directly permitted',
        old.lifecycle_status,
        new.lifecycle_status
      );
  end if;
  return new;
end
$$;

comment on function enforce_document_lifecycle_transition() is
  'INV-DOC-002, INV-DOC-007: until version effectivity lands, only PLANNED to RETIRED is directly reachable';

create trigger document_lifecycle_transition
  before insert or update of lifecycle_status on document
  for each row execute function enforce_document_lifecycle_transition();
create trigger enforce_row_version before update on document
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on document_variant
  for each row execute function enforce_row_version();

comment on constraint document_pkey on document is
  'INV-TEN-003: composite identity for a tenant document';
comment on constraint document_id_unique on document is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint document_tenant_fk on document is
  'INV-TEN-003: every document is anchored to its tenant';
comment on constraint document_tenant_code_unique on document is
  'INV-DOC-002: a tenant document has one stable register code';
comment on constraint document_type_fk on document is
  'INV-TEN-003, INV-DOC-005: the authoritative document type is tenant-contained and retained';
comment on constraint document_owner_fk on document is
  'INV-TEN-003, INV-DOC-006: an assigned owner is tenant-contained and retained';
comment on constraint document_owning_org_unit_fk on document is
  'INV-TEN-003, INV-AUTH-017: authorization containment follows the tenant owning-org-unit edge';
comment on constraint document_space_fk on document is
  'INV-TEN-003, INV-APL-010: filing space is tenant-contained and never applicability';
comment on constraint document_retirement_instant_consistent on document is
  'INV-DOC-002: only a RETIRED document records a retirement instant';
comment on constraint document_retirement_reason_required on document is
  'INV-DOC-002: retirement is an explicit transition with a non-empty reason';

comment on constraint document_variant_pkey on document_variant is
  'INV-TEN-003, INV-APL-011: composite identity for a tenant document variant';
comment on constraint document_variant_id_unique on document_variant is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint document_variant_tenant_fk on document_variant is
  'INV-TEN-003: every document variant is anchored to its tenant';
comment on constraint document_variant_document_fk on document_variant is
  'INV-TEN-003, INV-DOC-004, INV-APL-011: variants remain attached to their retained tenant document';
comment on constraint document_variant_source_fk on document_variant is
  'INV-TEN-003: a derived variant can reference only a retained variant in its tenant';
comment on constraint document_variant_baseline_source on document_variant is
  'INV-APL-011: the one baseline is the only variant without a source';
comment on constraint document_variant_translation_locale on document_variant is
  'INV-APL-006: every translation identifies its presentation locale';
comment on index one_baseline_per_document is
  'INV-APL-011: at most one BASELINE variant exists for each tenant document';

-- The audit ledger predates these governance coordinates. Add their tenant-qualified
-- references now that both target tables exist, validating under migration ownership.
alter table audit_event
  add constraint audit_event_document_fk
  foreign key (tenant_id, document_id)
  references document (tenant_id, id)
  on delete restrict
  not valid;
alter table audit_event
  add constraint audit_event_document_variant_fk
  foreign key (tenant_id, document_variant_id)
  references document_variant (tenant_id, id)
  on delete restrict
  not valid;
alter table audit_event no force row level security;
alter table audit_event validate constraint audit_event_document_fk;
alter table audit_event validate constraint audit_event_document_variant_fk;
alter table audit_event force row level security;

comment on constraint audit_event_document_fk on audit_event is
  'INV-TEN-003, INV-DOC-004: an audit coordinate is tenant-contained and cannot outlive its document';
comment on constraint audit_event_document_variant_fk on audit_event is
  'INV-TEN-003, INV-APL-011: an audit coordinate is tenant-contained and cannot outlive its variant';

alter table document enable row level security;
alter table document force row level security;
create policy tenant_isolation on document
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table document_variant enable row level security;
alter table document_variant force row level security;
create policy tenant_isolation on document_variant
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on document is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: document isolation fails closed';
comment on policy tenant_isolation on document_variant is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: document-variant isolation fails closed';

grant usage on type document_lifecycle, variant_type to app_role;
grant select, insert, update on document, document_variant to app_role;
revoke delete, truncate on document, document_variant from app_role;
