-- POL-039: approval runs are created atomically with revision submission.

create type run_status as enum (
  'RUNNING',
  'BLOCKED',
  'COMPLETED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'CANCELLED'
);
create type approval_stage_status as enum (
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'BLOCKED',
  'CANCELLED'
);
create type approval_task_status as enum (
  'PENDING',
  'DECIDED',
  'REASSIGNED',
  'UNRESOLVABLE',
  'CANCELLED'
);

create table approval_run (
  tenant_id                    uuid not null,
  id                           uuid not null default gen_random_uuid(),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  row_version                  integer not null default 1,
  content_revision_id          uuid not null,
  workflow_template_version_id uuid not null,
  resolved_participants        jsonb not null,
  status                       run_status not null,
  started_at                   timestamptz not null,
  completed_at                 timestamptz,
  cancelled_reason             text,
  configuration_version_id     uuid not null,
  constraint approval_run_pkey primary key (tenant_id, id),
  constraint approval_run_id_unique unique (id),
  constraint approval_run_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint approval_run_content_revision_fk
    foreign key (tenant_id, content_revision_id)
    references content_revision (tenant_id, id) on delete restrict,
  constraint approval_run_workflow_version_fk
    foreign key (tenant_id, workflow_template_version_id)
    references workflow_template_version (tenant_id, id) on delete restrict,
  constraint approval_run_configuration_version_fk
    foreign key (tenant_id, configuration_version_id)
    references configuration_version (tenant_id, id) on delete restrict,
  constraint approval_run_content_revision_unique unique (tenant_id, content_revision_id),
  constraint approval_run_resolved_participants_array
    check (jsonb_typeof(resolved_participants) = 'array')
);

create table approval_stage (
  tenant_id         uuid not null,
  id                uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  row_version       integer not null default 1,
  approval_run_id   uuid not null,
  stage_order       integer not null,
  completion_rule   completion_rule not null,
  threshold         integer,
  status            approval_stage_status not null,
  due_at            timestamptz,
  completed_at      timestamptz,
  constraint approval_stage_pkey primary key (tenant_id, id),
  constraint approval_stage_id_unique unique (id),
  constraint approval_stage_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint approval_stage_run_fk foreign key (tenant_id, approval_run_id)
    references approval_run (tenant_id, id) on delete restrict,
  constraint approval_stage_run_order_unique unique (tenant_id, approval_run_id, stage_order),
  constraint approval_stage_order_positive check (stage_order >= 1),
  constraint approval_stage_threshold_consistent check (
    (completion_rule = 'AT_LEAST_N' and threshold is not null and threshold > 1)
    or (completion_rule <> 'AT_LEAST_N' and threshold is null)
  )
);

create table approval_task (
  tenant_id             uuid not null,
  id                    uuid not null default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  row_version           integer not null default 1,
  approval_stage_id     uuid not null,
  participant_type      approval_participant_type not null,
  participant_id        uuid not null,
  status                approval_task_status not null,
  assigned_at           timestamptz not null,
  due_at                timestamptz,
  delegated_from_user_id uuid,
  constraint approval_task_pkey primary key (tenant_id, id),
  constraint approval_task_id_unique unique (id),
  constraint approval_task_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint approval_task_stage_fk foreign key (tenant_id, approval_stage_id)
    references approval_stage (tenant_id, id) on delete restrict,
  constraint approval_task_delegated_from_user_fk
    foreign key (tenant_id, delegated_from_user_id)
    references app_user (tenant_id, id) on delete restrict
);

create index approval_task_participant_status_idx
  on approval_task (tenant_id, participant_id, status);

comment on constraint approval_run_pkey on approval_run is
  'INV-TEN-003, INV-APR-012: composite identity for a tenant-owned frozen approval run';
comment on constraint approval_run_id_unique on approval_run is
  'INV-TEN-003: globally addressable approval-run IDs support tenant-contained references';
comment on constraint approval_run_tenant_fk on approval_run is
  'INV-TEN-003: every approval run is anchored to its tenant';
comment on constraint approval_run_content_revision_fk on approval_run is
  'INV-TEN-003, INV-APR-012: a run binds one exact tenant-contained candidate revision';
comment on constraint approval_run_workflow_version_fk on approval_run is
  'INV-TEN-003, INV-APR-012: a run binds the immutable tenant-contained template version used at start';
comment on constraint approval_run_configuration_version_fk on approval_run is
  'INV-TEN-003, INV-APR-024: a run records the tenant configuration in force at start';
comment on constraint approval_run_content_revision_unique on approval_run is
  'INV-APR-012: one submitted candidate can start at most one approval run';
comment on constraint approval_run_resolved_participants_array on approval_run is
  'INV-APR-012: frozen participant resolution is stored as the specified stage-ordered array';

comment on constraint approval_stage_pkey on approval_stage is
  'INV-TEN-003, INV-APR-008: composite identity for a tenant-owned approval stage';
comment on constraint approval_stage_id_unique on approval_stage is
  'INV-TEN-003: globally addressable stage IDs support tenant-contained references';
comment on constraint approval_stage_tenant_fk on approval_stage is
  'INV-TEN-003: every approval stage is anchored to its tenant';
comment on constraint approval_stage_run_fk on approval_stage is
  'INV-TEN-003, INV-APR-008: every stage belongs to a tenant-contained approval run';
comment on constraint approval_stage_run_order_unique on approval_stage is
  'INV-APR-008: each serial stage order appears once within a run';
comment on constraint approval_stage_order_positive on approval_stage is
  'INV-APR-008: serial approval-stage ordering begins at one';
comment on constraint approval_stage_threshold_consistent on approval_stage is
  'INV-APR-008: only AT_LEAST_N stages carry their positive threshold';

comment on constraint approval_task_pkey on approval_task is
  'INV-TEN-003: composite identity for a tenant-owned approval task';
comment on constraint approval_task_id_unique on approval_task is
  'INV-TEN-003: globally addressable task IDs support tenant-contained references';
comment on constraint approval_task_tenant_fk on approval_task is
  'INV-TEN-003: every approval task is anchored to its tenant';
comment on constraint approval_task_stage_fk on approval_task is
  'INV-TEN-003, INV-APR-008: every task belongs to a tenant-contained active stage';
comment on constraint approval_task_delegated_from_user_fk on approval_task is
  'INV-TEN-003: any delegation source is a tenant-contained user';
comment on column approval_task.participant_id is
  'Polymorphic by participant_type; INV-APR-012 freezes the resolved identity on approval_run';

create function assert_approval_run_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.tenant_id,
    new.id,
    new.content_revision_id,
    new.workflow_template_version_id,
    new.resolved_participants,
    new.started_at,
    new.configuration_version_id
  ) is distinct from row(
    old.tenant_id,
    old.id,
    old.content_revision_id,
    old.workflow_template_version_id,
    old.resolved_participants,
    old.started_at,
    old.configuration_version_id
  ) then
    raise exception 'approval-run evidence is immutable after start'
      using errcode = '23514', constraint = 'approval_run_snapshot_immutable';
  end if;
  return new;
end;
$$;

create trigger approval_run_snapshot_immutable
  before update on approval_run
  for each row execute function assert_approval_run_snapshot_immutable();
comment on trigger approval_run_snapshot_immutable on approval_run is
  'INV-APR-012: a running or historical run keeps the template and participant resolution captured at start';

create trigger enforce_row_version before update on approval_run
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on approval_stage
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on approval_task
  for each row execute function enforce_row_version();

comment on trigger enforce_row_version on approval_run is
  'INV-TIME-003: stale approval-run writes conflict instead of overwriting state';
comment on trigger enforce_row_version on approval_stage is
  'INV-TIME-003: stale approval-stage writes conflict instead of overwriting state';
comment on trigger enforce_row_version on approval_task is
  'INV-TIME-003: stale approval-task writes conflict instead of overwriting state';

alter table approval_run enable row level security;
alter table approval_run force row level security;
create policy tenant_isolation on approval_run
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table approval_stage enable row level security;
alter table approval_stage force row level security;
create policy tenant_isolation on approval_stage
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table approval_task enable row level security;
alter table approval_task force row level security;
create policy tenant_isolation on approval_task
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on approval_run is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: approval-run isolation fails closed';
comment on policy tenant_isolation on approval_stage is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: approval-stage isolation fails closed';
comment on policy tenant_isolation on approval_task is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: approval-task isolation fails closed';

grant usage on type run_status, approval_stage_status, approval_task_status to app_role;
grant select, insert, update on approval_run, approval_stage, approval_task to app_role;
revoke delete, truncate on approval_run, approval_stage, approval_task from app_role;
