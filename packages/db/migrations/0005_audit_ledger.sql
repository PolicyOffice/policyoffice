-- POL-007: the audit ledger and its gapless, commit-ordered per-tenant sequence.
--
-- The runner executes this file as migration_role. audit_event is the outbound cursor
-- source as well as the governance ledger; ADR-0006 explicitly rejects a second outbox.

create table tenant_event_sequence (
  tenant_id     uuid not null,
  next_sequence bigint not null default 1,
  constraint tenant_event_sequence_pkey primary key (tenant_id),
  constraint tenant_event_sequence_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint tenant_event_sequence_positive check (next_sequence >= 1)
);

comment on constraint tenant_event_sequence_pkey on tenant_event_sequence is
  'INV-TEN-003, INV-AUD-009: one tenant-scoped sequence cursor';
comment on constraint tenant_event_sequence_tenant_fk on tenant_event_sequence is
  'INV-TEN-003: the sequence cursor cannot reference another tenant';
comment on constraint tenant_event_sequence_positive on tenant_event_sequence is
  'INV-AUD-009: event sequence numbers start at one and increase monotonically';
comment on constraint tenant_event_sequence_tenant_id_not_null on tenant_event_sequence is
  'INV-TEN-003: every sequence cursor is tenant-scoped';
comment on constraint tenant_event_sequence_next_sequence_not_null on tenant_event_sequence is
  'INV-AUD-009: every tenant cursor names the next deterministic sequence';

-- Existing tenants receive their cursor during upgrade. The typed emitter uses an
-- INSERT .. ON CONFLICT allocation, so a tenant provisioned later is initialized by its
-- first event in the same transaction that records that event.
insert into tenant_event_sequence (tenant_id)
select id from tenant;

create table audit_event (
  tenant_id                uuid not null,
  event_id                 uuid not null default gen_random_uuid(),
  sequence                 bigint not null,
  event_type               text not null,
  event_schema_version     integer not null,
  occurred_at              timestamptz not null,
  recorded_at              timestamptz not null default now(),
  actor_type               text not null,
  actor_id                 uuid,
  originating_actor_id     uuid,
  elevation_session_id     uuid,
  subject_type             text not null,
  subject_id               uuid not null,
  document_id              uuid,
  document_variant_id      uuid,
  document_version_id      uuid,
  action                   text not null,
  outcome                  text not null,
  reason_code              text,
  request_id               uuid,
  correlation_id           uuid not null,
  source_channel           text not null,
  safe_before              jsonb,
  safe_after               jsonb,
  configuration_version_id uuid,
  corrects_event_id        uuid,
  dedupe_key               text,

  constraint audit_event_pkey primary key (tenant_id, sequence),
  constraint audit_event_event_id_unique unique (event_id),
  constraint audit_event_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint audit_event_dedupe_unique unique (tenant_id, dedupe_key),
  constraint audit_event_sequence_positive check (sequence >= 1),
  constraint audit_event_type_name check (
    event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint audit_event_schema_version_positive check (event_schema_version >= 1),
  constraint audit_event_actor_type check (
    actor_type in ('USER', 'BODY', 'API_CLIENT', 'SYSTEM')
  ),
  constraint audit_event_outcome check (outcome in ('SUCCESS', 'FAILURE')),
  constraint audit_event_source_channel check (
    source_channel in ('WEB', 'API', 'JOB', 'IMPORT')
  ),
  constraint audit_event_safe_snapshot_size check (
    coalesce(pg_column_size(safe_before), 0)
      + coalesce(pg_column_size(safe_after), 0) < 8192
  )
);

comment on constraint audit_event_pkey on audit_event is
  'INV-TEN-003, INV-AUD-009: deterministic total order is scoped to one tenant';
comment on constraint audit_event_event_id_unique on audit_event is
  'INV-AUD-001: every canonical event has one immutable identity';
comment on constraint audit_event_tenant_fk on audit_event is
  'INV-TEN-003: an audit event cannot reference another tenant';
comment on constraint audit_event_dedupe_unique on audit_event is
  'INV-AUD-001, INV-EFF-007: a governance transition has one canonical event';
comment on constraint audit_event_sequence_positive on audit_event is
  'INV-AUD-009: tenant event sequences begin at one';
comment on constraint audit_event_type_name on audit_event is
  'INV-AUD-008: event types use the permanent lowercase family.action contract';
comment on constraint audit_event_schema_version_positive on audit_event is
  'INV-AUD-008: every event names a positive contract version';
comment on constraint audit_event_actor_type on audit_event is
  'INV-AUD-005: every event identifies the kind of effective actor';
comment on constraint audit_event_outcome on audit_event is
  'INV-AUD-005: every event records a declared outcome';
comment on constraint audit_event_source_channel on audit_event is
  'INV-AUD-005: every event records its originating channel';
comment on constraint audit_event_safe_snapshot_size on audit_event is
  'INV-AUD-003: narrow audit metadata cannot become a document or arbitrary payload';
comment on constraint audit_event_tenant_id_not_null on audit_event is
  'INV-AUD-005, INV-TEN-003: every event names its tenant';
comment on constraint audit_event_event_id_not_null on audit_event is
  'INV-AUD-001: every canonical event has an immutable identity';
comment on constraint audit_event_sequence_not_null on audit_event is
  'INV-AUD-009: every event has a deterministic tenant-local order';
comment on constraint audit_event_event_type_not_null on audit_event is
  'INV-AUD-005, INV-AUD-008: every event names its permanent contract';
comment on constraint audit_event_event_schema_version_not_null on audit_event is
  'INV-AUD-008: every event names the contract version that produced it';
comment on constraint audit_event_occurred_at_not_null on audit_event is
  'INV-AUD-005: every event records its authoritative UTC instant';
comment on constraint audit_event_recorded_at_not_null on audit_event is
  'INV-AUD-005: every event records when the ledger received it';
comment on constraint audit_event_actor_type_not_null on audit_event is
  'INV-AUD-005: every event identifies its effective actor kind';
comment on constraint audit_event_subject_type_not_null on audit_event is
  'INV-AUD-005: every event identifies its governed subject kind';
comment on constraint audit_event_subject_id_not_null on audit_event is
  'INV-AUD-005: every event identifies its governed subject';
comment on constraint audit_event_action_not_null on audit_event is
  'INV-AUD-005: every event records the governed action';
comment on constraint audit_event_outcome_not_null on audit_event is
  'INV-AUD-005: every event records its outcome';
comment on constraint audit_event_correlation_id_not_null on audit_event is
  'INV-AUD-005: every event can be correlated to its operation';
comment on constraint audit_event_source_channel_not_null on audit_event is
  'INV-AUD-005: every event records its originating channel';

comment on column audit_event.tenant_id is
  'INV-AUD-005: tenant required by the canonical event envelope';
comment on column audit_event.event_type is
  'INV-AUD-005, INV-AUD-008: permanent versioned event contract';
comment on column audit_event.occurred_at is
  'INV-AUD-005: authoritative UTC instant required by the event envelope';
comment on column audit_event.actor_type is
  'INV-AUD-005: effective actor required by the event envelope';
comment on column audit_event.subject_type is
  'INV-AUD-005: governed subject required by the event envelope';
comment on column audit_event.subject_id is
  'INV-AUD-005: governed subject identity required by the event envelope';
comment on column audit_event.correlation_id is
  'INV-AUD-005: operation correlation required by the event envelope';

create index audit_event_document_sequence_idx
  on audit_event (tenant_id, document_id, sequence);
create index audit_event_correlation_idx
  on audit_event (tenant_id, correlation_id);

-- INV-TEN-001: both tables are tenant-owned, including the cursor. The owner is the
-- deliberately non-bypassing migration_role, and FORCE subjects it to the same policy.
alter table tenant_event_sequence enable row level security;
alter table tenant_event_sequence force row level security;
create policy tenant_isolation on tenant_event_sequence
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table audit_event enable row level security;
alter table audit_event force row level security;
create policy tenant_isolation on audit_event
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on tenant_event_sequence is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';
comment on policy tenant_isolation on audit_event is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: tenant isolation fails closed';

grant usage on schema public to retention_role;
grant select, insert, update on tenant_event_sequence to app_role;
grant select, insert on audit_event to app_role;

-- INV-AUD-002: corrections are new compensating events. No application surface may
-- rewrite, remove or truncate the governance record.
revoke update, delete, truncate on audit_event from app_role;

grant select, delete on audit_event to retention_role;
revoke insert, update, truncate on audit_event from retention_role;
