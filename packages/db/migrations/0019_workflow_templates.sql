-- POL-038: tenant-owned, immutable workflow-template versions and their authority floor.

create type workflow_template_status as enum ('ACTIVE', 'RETIRED');
create type completion_rule as enum ('ALL', 'ANY_ONE', 'AT_LEAST_N', 'BODY_RESOLUTION');
create type approval_participant_type as enum (
  'USER',
  'ROLE_AT_SCOPE',
  'GROUP',
  'GOVERNANCE_BODY'
);

comment on type completion_rule is
  'The complete workflow completion vocabulary; the Pilot parser accepts only ALL and BODY_RESOLUTION';
comment on type approval_participant_type is
  'The shared participant vocabulary for template stages, mandates and future approval tasks';

create table workflow_template (
  tenant_id        uuid not null,
  id               uuid not null default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  row_version      integer not null default 1,
  name             text not null,
  purpose          text not null,
  active_version_id uuid,
  status           workflow_template_status not null,
  constraint workflow_template_pkey primary key (tenant_id, id),
  constraint workflow_template_id_unique unique (id),
  constraint workflow_template_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict
);

create table workflow_template_version (
  tenant_id                    uuid not null,
  id                           uuid not null default gen_random_uuid(),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  row_version                  integer not null default 1,
  workflow_template_id         uuid not null,
  version_sequence             integer not null,
  stages                       jsonb not null,
  separation_of_duties_rules   jsonb not null,
  published_at                 timestamptz not null,
  published_by                 uuid not null,
  constraint workflow_template_version_pkey primary key (tenant_id, id),
  constraint workflow_template_version_id_unique unique (id),
  constraint workflow_template_version_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint workflow_template_version_template_fk
    foreign key (tenant_id, workflow_template_id)
    references workflow_template (tenant_id, id) on delete restrict,
  constraint workflow_template_version_published_by_fk
    foreign key (tenant_id, published_by)
    references app_user (tenant_id, id) on delete restrict,
  constraint workflow_template_version_template_id_unique
    unique (tenant_id, workflow_template_id, id),
  constraint workflow_template_version_sequence_unique
    unique (tenant_id, workflow_template_id, version_sequence),
  constraint workflow_template_version_sequence_positive check (version_sequence >= 1)
);

alter table workflow_template
  add constraint workflow_template_active_version_fk
  foreign key (tenant_id, id, active_version_id)
  references workflow_template_version (tenant_id, workflow_template_id, id)
  on delete restrict;

-- Constraint validation must inspect every existing type during an upgrade. The schema
-- owner is deliberately subject to FORCE RLS, so suspend only that owner restriction
-- inside this transactional migration and restore it before commit.
alter table document_type no force row level security;
alter table document_type
  add constraint document_type_default_workflow_template_fk
  foreign key (tenant_id, default_workflow_template_id)
  references workflow_template (tenant_id, id)
  on delete restrict;
alter table document_type force row level security;

comment on constraint workflow_template_pkey on workflow_template is
  'INV-TEN-003: composite identity for a tenant-owned workflow template';
comment on constraint workflow_template_id_unique on workflow_template is
  'INV-TEN-003: globally addressable template IDs support tenant-contained references';
comment on constraint workflow_template_tenant_fk on workflow_template is
  'INV-TEN-003: every workflow template is anchored to its tenant';
comment on constraint workflow_template_active_version_fk on workflow_template is
  'INV-TEN-003, INV-APR-010: the active immutable version belongs to this template and tenant';

comment on constraint workflow_template_version_pkey on workflow_template_version is
  'INV-TEN-003, INV-APR-010: composite identity for an immutable tenant template version';
comment on constraint workflow_template_version_id_unique on workflow_template_version is
  'INV-TEN-003, INV-APR-010: globally addressable version IDs support retained references';
comment on constraint workflow_template_version_tenant_fk on workflow_template_version is
  'INV-TEN-003: every workflow template version is anchored to its tenant';
comment on constraint workflow_template_version_template_fk on workflow_template_version is
  'INV-TEN-003, INV-APR-010: every immutable version belongs to a tenant-contained template';
comment on constraint workflow_template_version_published_by_fk on workflow_template_version is
  'INV-TEN-003, INV-APR-010: the publishing actor is tenant-contained and retained';
comment on constraint workflow_template_version_template_id_unique on workflow_template_version is
  'INV-TEN-003, INV-APR-010: supports a same-template active-version reference';
comment on constraint workflow_template_version_sequence_unique on workflow_template_version is
  'INV-APR-010: each immutable version has a distinct sequence within its template';
comment on constraint workflow_template_version_sequence_positive on workflow_template_version is
  'INV-APR-010: immutable template version history starts at sequence one';

comment on constraint document_type_default_workflow_template_fk on document_type is
  'INV-TEN-003, INV-APR-020: a document type can name only a tenant-contained workflow template';
comment on column document_type.default_workflow_template_id is
  'INV-APR-020: domain commands refuse a template whose active version is below the type mandate';

create trigger enforce_row_version before update on workflow_template
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on workflow_template_version
  for each row execute function enforce_row_version();

comment on trigger enforce_row_version on workflow_template is
  'INV-TIME-003: stale template writes conflict instead of overwriting configuration';
comment on trigger enforce_row_version on workflow_template_version is
  'INV-TIME-003, INV-APR-010: even privileged version writes must advance concurrency state';

alter table workflow_template enable row level security;
alter table workflow_template force row level security;
create policy tenant_isolation on workflow_template
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table workflow_template_version enable row level security;
alter table workflow_template_version force row level security;
create policy tenant_isolation on workflow_template_version
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on workflow_template is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: workflow-template isolation fails closed';
comment on policy tenant_isolation on workflow_template_version is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: workflow-version isolation fails closed';

grant usage on type workflow_template_status, completion_rule, approval_participant_type
  to app_role;
grant select, insert, update on workflow_template to app_role;
grant select, insert on workflow_template_version to app_role;

-- INV-APR-010: published versions are evidence-bearing configuration history.
revoke update, delete, truncate on workflow_template_version from app_role;
revoke delete, truncate on workflow_template from app_role;
