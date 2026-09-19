-- POL-040: immutable approval decisions advance frozen approval runs.

create type approval_decision_kind as enum (
  'APPROVE',
  'REQUEST_CHANGES',
  'REJECT'
);

create table approval_decision (
  tenant_id                    uuid not null,
  id                           uuid not null default gen_random_uuid(),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  row_version                  integer not null default 1,
  approval_task_id             uuid not null,
  decision                     approval_decision_kind not null,
  decided_by_type              text not null,
  decided_by_id                uuid not null,
  recorded_by_user_id          uuid not null,
  recorded_at                  timestamptz not null default now(),
  content_revision_id          uuid not null,
  content_digest               text not null,
  reason_code                  text,
  comment_ref                  uuid,
  resolution_reference         text,
  resolution_date              date,
  minutes_attachment_id        uuid,
  attending_members            uuid[],
  configuration_version_id     uuid not null,
  constraint approval_decision_pkey primary key (tenant_id, id),
  constraint approval_decision_id_unique unique (id),
  constraint approval_decision_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint approval_decision_task_fk foreign key (tenant_id, approval_task_id)
    references approval_task (tenant_id, id) on delete restrict,
  constraint approval_decision_recorded_by_user_fk
    foreign key (tenant_id, recorded_by_user_id)
    references app_user (tenant_id, id) on delete restrict,
  constraint approval_decision_content_revision_fk
    foreign key (tenant_id, content_revision_id)
    references content_revision (tenant_id, id) on delete restrict,
  constraint approval_decision_minutes_attachment_fk
    foreign key (tenant_id, minutes_attachment_id)
    references content_attachment (tenant_id, id) on delete restrict,
  constraint approval_decision_configuration_version_fk
    foreign key (tenant_id, configuration_version_id)
    references configuration_version (tenant_id, id) on delete restrict,
  constraint approval_decision_task_unique unique (tenant_id, approval_task_id),
  constraint approval_decision_actor_type_valid
    check (decided_by_type in ('USER', 'BODY')),
  constraint approval_decision_body_recorder_required
    check (decided_by_type <> 'BODY' or recorded_by_user_id is not null),
  constraint approval_decision_content_digest_format
    check (content_digest ~ '^sha-256:[0-9a-f]{64}$')
);

comment on constraint approval_decision_pkey on approval_decision is
  'INV-TEN-003, INV-APR-001: composite identity for a tenant-owned approval decision';
comment on constraint approval_decision_id_unique on approval_decision is
  'INV-TEN-003: globally addressable approval-decision IDs support tenant-contained references';
comment on constraint approval_decision_tenant_fk on approval_decision is
  'INV-TEN-003: every approval decision is anchored to its tenant';
comment on constraint approval_decision_task_fk on approval_decision is
  'INV-TEN-003, INV-APR-001: every decision belongs to a tenant-contained approval task';
comment on constraint approval_decision_recorded_by_user_fk on approval_decision is
  'INV-TEN-003, INV-APR-021: the recording user is a tenant-contained principal';
comment on constraint approval_decision_content_revision_fk on approval_decision is
  'INV-TEN-003, INV-APR-001: every decision names the exact tenant-contained content revision';
comment on constraint approval_decision_minutes_attachment_fk on approval_decision is
  'INV-TEN-003, INV-APR-024: body-resolution minutes remain tenant-contained evidence';
comment on constraint approval_decision_configuration_version_fk on approval_decision is
  'INV-TEN-003, INV-APR-024: every decision records the tenant configuration in force';
comment on constraint approval_decision_task_unique on approval_decision is
  'INV-APR-009: an approval task carries at most one immutable decision';
comment on constraint approval_decision_actor_type_valid on approval_decision is
  'INV-APR-001, INV-APR-021: a decision identifies either a user or a governance body';
comment on constraint approval_decision_body_recorder_required on approval_decision is
  'INV-APR-021: a body decision always names the user who recorded it';
comment on constraint approval_decision_content_digest_format on approval_decision is
  'INV-APR-001: the decision stores the exact candidate sha-256 digest';

create trigger enforce_row_version before update on approval_decision
  for each row execute function enforce_row_version();
comment on trigger enforce_row_version on approval_decision is
  'INV-TIME-003: privileged stale approval-decision writes conflict instead of overwriting state';

alter table approval_decision enable row level security;
alter table approval_decision force row level security;
create policy tenant_isolation on approval_decision
  using (tenant_id = current_setting('app.tenant_id')::uuid);
comment on policy tenant_isolation on approval_decision is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: approval-decision isolation fails closed';

grant usage on type approval_decision_kind to app_role;
grant select, insert on approval_decision to app_role;
revoke update, delete, truncate on approval_decision from app_role;
