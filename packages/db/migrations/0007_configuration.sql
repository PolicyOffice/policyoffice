-- POL-011: versioned tenant configuration and the document taxonomy foundation.

create type document_type_status as enum ('ACTIVE', 'RETIRED');
create type information_classification_status as enum ('ACTIVE', 'RETIRED');

create table configuration_version (
  tenant_id       uuid not null,
  id              uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1,
  sequence        integer not null,
  effective_from  timestamptz not null,
  changed_by      uuid not null,
  change_reason   text not null,
  weakening       boolean not null default false,
  payload_digest  text not null,
  constraint configuration_version_pkey primary key (tenant_id, id),
  constraint configuration_version_id_unique unique (id),
  constraint configuration_version_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint configuration_version_changed_by_fk foreign key (tenant_id, changed_by)
    references app_user (tenant_id, id) on delete restrict,
  constraint configuration_version_tenant_sequence_unique unique (tenant_id, sequence),
  constraint configuration_version_sequence_positive check (sequence >= 1)
);

create table document_type (
  tenant_id                         uuid not null,
  id                                uuid not null default gen_random_uuid(),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  row_version                       integer not null default 1,
  code                              text not null,
  name                              text not null,
  rank                              integer not null,
  mandated_authority                jsonb not null,
  default_workflow_template_id      uuid,
  default_review_rule               jsonb not null,
  requires_attestation_by_default   boolean not null default false,
  mandated_by_document_version_id   uuid,
  status                            document_type_status not null,
  constraint document_type_pkey primary key (tenant_id, id),
  constraint document_type_id_unique unique (id),
  constraint document_type_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint document_type_tenant_code_unique unique (tenant_id, code),
  constraint document_type_tenant_rank_unique unique (tenant_id, rank)
);

create table information_classification (
  tenant_id              uuid not null,
  id                     uuid not null default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  row_version            integer not null default 1,
  code                   text not null,
  name                   text not null,
  rank                   integer not null,
  handling_instructions  text not null,
  externally_disclosable boolean not null,
  status                 information_classification_status not null,
  constraint information_classification_pkey primary key (tenant_id, id),
  constraint information_classification_id_unique unique (id),
  constraint information_classification_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint information_classification_tenant_code_unique unique (tenant_id, code),
  constraint information_classification_tenant_rank_unique unique (tenant_id, rank)
);

create index configuration_version_changed_by_idx
  on configuration_version (tenant_id, changed_by);
create index audit_event_configuration_version_idx
  on audit_event (tenant_id, configuration_version_id);

-- The audit table predates configuration_version. No production transition currently
-- writes it, so validation is safe; NOT VALID avoids a long initial lock once it has data.
alter table audit_event
  add constraint audit_event_configuration_version_fk
  foreign key (tenant_id, configuration_version_id)
  references configuration_version (tenant_id, id)
  on delete restrict
  not valid;
-- migration_role owns audit_event and is deliberately bound by FORCE RLS. Constraint
-- validation must inspect every tenant, so remove the owner restriction only inside this
-- transactional migration, validate, and restore it before the transaction can commit.
alter table audit_event no force row level security;
alter table audit_event validate constraint audit_event_configuration_version_fk;
alter table audit_event force row level security;

-- The target tables arrive in later document/workflow migrations. These nullable forward
-- references cannot carry tenant-qualified foreign keys until those tables exist.
comment on column document_type.mandated_by_document_version_id is
  'POL-013 (#51) adds the composite foreign key when it creates document_version';
comment on column document_type.default_workflow_template_id is
  'A later workflow migration adds the composite foreign key when it creates workflow_template';

create trigger enforce_row_version before update on configuration_version
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on document_type
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on information_classification
  for each row execute function enforce_row_version();

comment on constraint configuration_version_pkey on configuration_version is
  'INV-TEN-003, INV-CFG-003: composite identity for a tenant configuration version';
comment on constraint configuration_version_id_unique on configuration_version is
  'INV-TEN-003, INV-CFG-003: globally addressable IDs support tenant-contained references';
comment on constraint configuration_version_tenant_fk on configuration_version is
  'INV-TEN-003: every configuration version is anchored to its tenant';
comment on constraint configuration_version_changed_by_fk on configuration_version is
  'INV-TEN-003, INV-CFG-004: the changing actor is tenant-contained and retained';
comment on constraint configuration_version_tenant_sequence_unique on configuration_version is
  'INV-CFG-006: every tenant configuration change appends one distinct sequence';
comment on constraint configuration_version_sequence_positive on configuration_version is
  'INV-CFG-006: configuration history starts at sequence one and advances by appending';

comment on constraint document_type_pkey on document_type is
  'INV-TEN-003, INV-DOC-005: composite identity for an authoritative tenant document type';
comment on constraint document_type_id_unique on document_type is
  'INV-TEN-003, INV-DOC-005: globally addressable IDs support tenant-contained references';
comment on constraint document_type_tenant_fk on document_type is
  'INV-TEN-003: every document type is anchored to its tenant';
comment on constraint document_type_tenant_code_unique on document_type is
  'INV-DOC-005: a tenant document type has one stable code';
comment on constraint document_type_tenant_rank_unique on document_type is
  'INV-DOC-005: document authority rank is unique within a tenant';

comment on constraint information_classification_pkey on information_classification is
  'INV-TEN-003, INV-AUTH-019: composite identity for a tenant classification label';
comment on constraint information_classification_id_unique on information_classification is
  'INV-TEN-003, INV-AUTH-019: globally addressable IDs support tenant-contained references';
comment on constraint information_classification_tenant_fk on information_classification is
  'INV-TEN-003, INV-AUTH-019: every classification label is anchored to its tenant';
comment on constraint information_classification_tenant_code_unique on information_classification is
  'INV-AUTH-019: classification codes identify labels, never capabilities';
comment on constraint information_classification_tenant_rank_unique on information_classification is
  'INV-AUTH-019: classification rank orders labels without granting access';

comment on constraint audit_event_configuration_version_fk on audit_event is
  'INV-TEN-003, INV-CFG-003: a recorded configuration reference is tenant-contained and retained';

alter table configuration_version enable row level security;
alter table configuration_version force row level security;
create policy tenant_isolation on configuration_version
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table document_type enable row level security;
alter table document_type force row level security;
create policy tenant_isolation on document_type
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table information_classification enable row level security;
alter table information_classification force row level security;
create policy tenant_isolation on information_classification
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on configuration_version is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: configuration isolation fails closed';
comment on policy tenant_isolation on document_type is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: document-type isolation fails closed';
comment on policy tenant_isolation on information_classification is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: classification isolation fails closed';

grant usage on type document_type_status, information_classification_status to app_role;
grant select, insert on configuration_version, document_type, information_classification
  to app_role;
grant update on document_type, information_classification to app_role;

-- INV-CFG-006: configuration changes append; taxonomy records retire in place and remain.
revoke update on configuration_version from app_role;
revoke delete, truncate on configuration_version, document_type, information_classification
  from app_role;
