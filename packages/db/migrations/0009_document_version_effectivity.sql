-- POL-013: governed document versions, effectivity intervals and immutability.

create type version_lifecycle as enum (
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'EFFECTIVE',
  'SUPERSEDED',
  'WITHDRAWN',
  'REJECTED',
  'CANCELLED'
);

create type materiality as enum ('EDITORIAL', 'NON_MATERIAL', 'MATERIAL', 'EMERGENCY');

create table document_version (
  tenant_id                 uuid not null,
  id                        uuid not null default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  row_version               integer not null default 1,
  document_variant_id       uuid not null,
  version_sequence          integer not null,
  display_label             text,
  lifecycle_state           version_lifecycle not null default 'DRAFT',
  document_type_id          uuid not null,
  title                     text not null,
  classification_id        uuid not null,
  approved_revision_id      uuid,
  content_digest            text,
  materiality               materiality,
  change_summary            text,
  approved_at               timestamptz,
  published_at              timestamptz,
  effective_from            timestamptz,
  effective_until           timestamptz,
  superseded_by_version_id  uuid,
  withdrawn_at              timestamptz,
  withdrawal_reason         text,
  configuration_version_id  uuid,
  effective_range           tstzrange generated always as (
    case
      when effective_from is null then null
      else tstzrange(effective_from, effective_until, '[)')
    end
  ) stored,
  constraint document_version_pkey primary key (tenant_id, id),
  constraint document_version_id_unique unique (id),
  constraint document_version_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint document_version_variant_fk foreign key (tenant_id, document_variant_id)
    references document_variant (tenant_id, id) on delete restrict,
  constraint document_version_type_fk foreign key (tenant_id, document_type_id)
    references document_type (tenant_id, id) on delete restrict,
  constraint document_version_classification_fk foreign key (tenant_id, classification_id)
    references information_classification (tenant_id, id) on delete restrict,
  constraint document_version_configuration_fk foreign key (tenant_id, configuration_version_id)
    references configuration_version (tenant_id, id) on delete restrict,
  constraint document_version_successor_fk foreign key (tenant_id, superseded_by_version_id)
    references document_version (tenant_id, id) on delete restrict,
  constraint document_version_variant_sequence_unique
    unique (tenant_id, document_variant_id, version_sequence),
  constraint document_version_withdrawal_reason_required check (
    lifecycle_state <> 'WITHDRAWN'
    or nullif(btrim(withdrawal_reason), '') is not null
  ),
  constraint document_version_effective_interval_start_required check (
    effective_until is null or effective_from is not null
  )
);

-- INV-EFF-002 and INV-TIME-005: one variant cannot claim an instant twice, while
-- consecutive half-open intervals can meet at one boundary.
alter table document_version
  add constraint one_effective_version_per_variant
  exclude using gist (
    tenant_id with =,
    document_variant_id with =,
    effective_range with &&
  ) where (effective_range is not null);

-- INV-VER-012: a variant has one open candidate, including an approved candidate
-- waiting for publication.
create unique index one_pre_release_version_per_variant
  on document_version (tenant_id, document_variant_id)
  where lifecycle_state in ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED');

create index document_version_variant_idx
  on document_version (tenant_id, document_variant_id);
create index document_version_type_idx
  on document_version (tenant_id, document_type_id);
create index document_version_classification_idx
  on document_version (tenant_id, classification_id);
create index document_version_configuration_idx
  on document_version (tenant_id, configuration_version_id);
create index document_version_successor_idx
  on document_version (tenant_id, superseded_by_version_id);

comment on constraint document_version_pkey on document_version is
  'INV-TEN-003: composite identity for a tenant document version';
comment on constraint document_version_id_unique on document_version is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint document_version_tenant_fk on document_version is
  'INV-TEN-003: every document version is anchored to its tenant';
comment on constraint document_version_variant_fk on document_version is
  'INV-TEN-003, INV-DOC-004: every version belongs to a retained variant in its tenant';
comment on constraint document_version_type_fk on document_version is
  'INV-TEN-003, INV-DOC-009: the submitted document type is tenant-contained and retained';
comment on constraint document_version_classification_fk on document_version is
  'INV-TEN-003, INV-DOC-010: the submitted classification is tenant-contained and retained';
comment on constraint document_version_configuration_fk on document_version is
  'INV-TEN-003, INV-CFG-003: the governing configuration is tenant-contained and retained';
comment on constraint document_version_successor_fk on document_version is
  'INV-TEN-003: a successor reference cannot cross tenants or outlive its source version';
comment on constraint document_version_variant_sequence_unique on document_version is
  'INV-VER-011: a variant sequence identifies one retained version and is never reused';
comment on constraint document_version_withdrawal_reason_required on document_version is
  'INV-VER-005: withdrawal is an explicit correction with a recorded reason';
comment on constraint document_version_effective_interval_start_required on document_version is
  'An interval cannot close unless it first has a lower bound';
comment on constraint one_effective_version_per_variant on document_version is
  'INV-EFF-002, INV-TIME-005: one version per variant claims each instant using half-open intervals';
comment on index one_pre_release_version_per_variant is
  'INV-VER-012: at most one pre-release version exists for a variant';
comment on constraint document_version_document_type_id_not_null on document_version is
  'INV-DOC-009: every version records the type under which it was submitted';
comment on constraint document_version_title_not_null on document_version is
  'INV-DOC-010: every version records the submitted title';
comment on constraint document_version_classification_id_not_null on document_version is
  'INV-DOC-010: every version records the submitted classification';
comment on column document_version.approved_revision_id is
  'POL-014 (#52) adds the composite foreign key when it creates content_revision';
comment on column document_version.effective_range is
  'INV-EFF-002, INV-EFF-006, INV-TIME-005: generated STORED half-open interval; null before publication';

-- INV-VER-003/007: a released or terminal row cannot be thawed, and every field
-- an approver relied upon remains frozen. Effectivity timestamps are the sole exception:
-- only migration-owned execution may assign each null timestamp once, allowing POL-016
-- to expose one narrow, audited SECURITY DEFINER publication function without granting
-- app_role a bypass or permitting the publication path to rewrite history.
create function assert_governed_columns_unchanged() returns trigger
language plpgsql
as $$
declare
  frozen_state boolean := old.lifecycle_state in (
    'APPROVED', 'PUBLISHED', 'EFFECTIVE', 'SUPERSEDED',
    'WITHDRAWN', 'REJECTED', 'CANCELLED'
  );
  new_frozen_state boolean := new.lifecycle_state in (
    'APPROVED', 'PUBLISHED', 'EFFECTIVE', 'SUPERSEDED',
    'WITHDRAWN', 'REJECTED', 'CANCELLED'
  );
  effectivity_changed boolean :=
    new.effective_from is distinct from old.effective_from
    or new.effective_until is distinct from old.effective_until;
begin
  if not frozen_state then
    return new;
  end if;

  if not new_frozen_state
     or new.document_variant_id is distinct from old.document_variant_id
     or new.version_sequence is distinct from old.version_sequence
     or new.document_type_id is distinct from old.document_type_id
     or new.title is distinct from old.title
     or new.classification_id is distinct from old.classification_id
     or new.materiality is distinct from old.materiality
     or new.change_summary is distinct from old.change_summary
     or new.content_digest is distinct from old.content_digest
     or new.approved_revision_id is distinct from old.approved_revision_id
     or new.configuration_version_id is distinct from old.configuration_version_id then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_governed_columns_immutable',
      message = 'approved document version governed columns are immutable';
  end if;

  if effectivity_changed
     and (
       current_user <> 'migration_role'
       or (
         new.effective_from is distinct from old.effective_from
         and old.effective_from is not null
       )
       or (
         new.effective_until is distinct from old.effective_until
         and old.effective_until is not null
       )
     ) then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_governed_columns_immutable',
      message = 'effectivity timestamps may be assigned once only by the controlled publication path';
  end if;

  return new;
end
$$;

comment on function assert_governed_columns_unchanged() is
  'INV-VER-003, INV-VER-007: freezes approver-relied-upon fields and makes migration-owned effectivity writes single-assignment';

create trigger document_version_governed_columns_immutable
  before update on document_version
  for each row execute function assert_governed_columns_unchanged();

create trigger enforce_row_version before update on document_version
  for each row execute function enforce_row_version();

-- INV-DOC-008: retirement cannot become a quiet substitute for withdrawal. The
-- interval, not the lifecycle bookkeeping state, decides whether a version is normative.
create function assert_no_effective_version() returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from document_variant variant
      join document_version version
        on version.tenant_id = variant.tenant_id
       and version.document_variant_id = variant.id
     where variant.tenant_id = new.tenant_id
       and variant.document_id = new.id
       and version.effective_range @> statement_timestamp()
       and version.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'document_no_retire_while_effective',
      message = 'a document with a currently effective version cannot be retired';
  end if;
  return new;
end
$$;

comment on function assert_no_effective_version() is
  'INV-DOC-008, INV-EFF-006: retirement checks the dated normative interval, never a current flag';

create trigger document_no_retire_while_effective
  before update of lifecycle_status on document
  for each row
  when (new.lifecycle_status = 'RETIRED' and old.lifecycle_status is distinct from new.lifecycle_status)
  execute function assert_no_effective_version();

-- Resolve the forward reference introduced by POL-011 now that versions exist.
alter table document_type
  add constraint document_type_mandated_by_version_fk
  foreign key (tenant_id, mandated_by_document_version_id)
  references document_version (tenant_id, id)
  on delete restrict
  not valid;
alter table document_type no force row level security;
alter table document_type validate constraint document_type_mandated_by_version_fk;
alter table document_type force row level security;

comment on constraint document_type_mandated_by_version_fk on document_type is
  'INV-TEN-003: mandated authority provenance is tenant-contained and retained';

-- The ledger coordinate becomes referentially complete with this table.
alter table audit_event
  add constraint audit_event_document_version_fk
  foreign key (tenant_id, document_version_id)
  references document_version (tenant_id, id)
  on delete restrict
  not valid;
alter table audit_event no force row level security;
alter table audit_event validate constraint audit_event_document_version_fk;
alter table audit_event force row level security;

comment on constraint audit_event_document_version_fk on audit_event is
  'INV-TEN-003: a version audit coordinate is tenant-contained and retained';

alter table document_version enable row level security;
alter table document_version force row level security;
create policy tenant_isolation on document_version
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on document_version is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: document-version isolation fails closed';

grant usage on type version_lifecycle, materiality to app_role;
grant select, insert, update on document_version to app_role;
revoke delete, truncate on document_version from app_role;
