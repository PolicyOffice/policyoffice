-- POL-014: governed drafting revisions and their incorporated attachments.

create table content_revision (
  tenant_id                       uuid not null,
  id                              uuid not null default gen_random_uuid(),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  row_version                     integer not null default 1,
  document_version_id             uuid not null,
  revision_sequence               integer not null,
  content_ref                     text,
  canonical_manifest              jsonb not null,
  canonicalisation_schema_version integer not null,
  content_digest                  text not null,
  created_by                      uuid not null,
  submitted_at                    timestamptz,
  constraint content_revision_pkey primary key (tenant_id, id),
  constraint content_revision_id_unique unique (id),
  constraint content_revision_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint content_revision_version_fk foreign key (tenant_id, document_version_id)
    references document_version (tenant_id, id) on delete restrict,
  constraint content_revision_created_by_fk foreign key (tenant_id, created_by)
    references app_user (tenant_id, id) on delete restrict,
  constraint content_revision_version_sequence_unique
    unique (tenant_id, document_version_id, revision_sequence),
  constraint content_revision_sequence_positive check (revision_sequence >= 1),
  constraint content_revision_manifest_is_canonical_text check (
    jsonb_typeof(canonical_manifest) = 'string'
    and octet_length(canonical_manifest #>> '{}') > 0
  ),
  constraint content_revision_schema_version_v1 check (
    canonicalisation_schema_version = 1
  ),
  constraint content_revision_digest_format check (
    content_digest ~ '^sha-256:[0-9a-f]{64}$'
  ),
  constraint content_revision_content_ref_tenant_partitioned check (
    content_ref is null
    or content_ref ~ ('^t/' || tenant_id::text || '/blob/[0-9a-f]{64}$')
  )
);

create table content_attachment (
  tenant_id          uuid not null,
  id                 uuid not null default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  row_version        integer not null default 1,
  content_revision_id uuid not null,
  filename           text not null,
  media_type         text not null,
  byte_size          bigint not null,
  storage_ref        text not null,
  digest             text not null,
  constraint content_attachment_pkey primary key (tenant_id, id),
  constraint content_attachment_id_unique unique (id),
  constraint content_attachment_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint content_attachment_revision_fk foreign key (tenant_id, content_revision_id)
    references content_revision (tenant_id, id) on delete restrict,
  constraint content_attachment_filename_not_blank check (
    nullif(btrim(filename), '') is not null
  ),
  constraint content_attachment_media_type_not_blank check (
    nullif(btrim(media_type), '') is not null
  ),
  constraint content_attachment_byte_size_nonnegative check (byte_size >= 0),
  constraint content_attachment_digest_format check (
    digest ~ '^sha-256:[0-9a-f]{64}$'
  ),
  constraint content_attachment_storage_ref_tenant_partitioned check (
    storage_ref ~ ('^t/' || tenant_id::text || '/blob/[0-9a-f]{64}$')
  )
);

create index content_revision_version_idx
  on content_revision (tenant_id, document_version_id);
create index content_revision_created_by_idx
  on content_revision (tenant_id, created_by);
create index content_attachment_revision_idx
  on content_attachment (tenant_id, content_revision_id);

comment on constraint content_revision_pkey on content_revision is
  'INV-TEN-003: composite identity for a tenant content revision';
comment on constraint content_revision_id_unique on content_revision is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint content_revision_tenant_fk on content_revision is
  'INV-TEN-003: every content revision is anchored to its tenant';
comment on constraint content_revision_version_fk on content_revision is
  'INV-TEN-003, INV-DOC-004: every revision belongs to a retained version in its tenant';
comment on constraint content_revision_created_by_fk on content_revision is
  'INV-TEN-003: revision authorship is attributed to a principal in the same tenant';
comment on constraint content_revision_version_sequence_unique on content_revision is
  'INV-VER-001, INV-VER-010: the ordered drafting trail retains every distinct revision';
comment on constraint content_revision_sequence_positive on content_revision is
  'INV-VER-001: drafting order starts at one and advances through content revisions';
comment on constraint content_revision_manifest_is_canonical_text on content_revision is
  'INV-VER-009: the exact canonical JSON bytes are retained as a JSONB string scalar';
comment on constraint content_revision_schema_version_v1 on content_revision is
  'INV-VER-009: every revision records the canonicalisation rules that produced its digest';
comment on constraint content_revision_digest_format on content_revision is
  'INV-VER-009: revision digests carry the explicit sha-256 algorithm prefix';
comment on constraint content_revision_content_ref_tenant_partitioned on content_revision is
  'INV-TEN-001, INV-VER-009: controlled content references cannot cross the tenant partition';

comment on constraint content_attachment_pkey on content_attachment is
  'INV-TEN-003: composite identity for a tenant governed attachment';
comment on constraint content_attachment_id_unique on content_attachment is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint content_attachment_tenant_fk on content_attachment is
  'INV-TEN-003: every governed attachment is anchored to its tenant';
comment on constraint content_attachment_revision_fk on content_attachment is
  'INV-TEN-003, INV-DOC-004, INV-VER-013: every attachment belongs to a retained revision in its tenant';
comment on constraint content_attachment_filename_not_blank on content_attachment is
  'INV-VER-013: every governed attachment has a manifest filename';
comment on constraint content_attachment_media_type_not_blank on content_attachment is
  'INV-VER-013: every governed attachment records its inspected media type';
comment on constraint content_attachment_byte_size_nonnegative on content_attachment is
  'INV-VER-013: every governed attachment records its inspected byte size';
comment on constraint content_attachment_digest_format on content_attachment is
  'INV-VER-009, INV-VER-013: every attachment carries a prefixed digest included in the manifest';
comment on constraint content_attachment_storage_ref_tenant_partitioned on content_attachment is
  'INV-TEN-001, INV-VER-013: governed attachment objects cannot cross the tenant partition';

create function reject_submitted_content_revision_update() returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '23514',
    constraint = 'content_revision_immutable_after_submission',
    message = 'a submitted content revision is immutable';
end
$$;

comment on function reject_submitted_content_revision_update() is
  'INV-VER-002, INV-VER-010: submitted content, manifest and digest remain frozen forever';

create trigger content_revision_immutable_after_submission
  before update on content_revision
  for each row
  when (old.submitted_at is not null)
  execute function reject_submitted_content_revision_update();

comment on trigger content_revision_immutable_after_submission on content_revision is
  'INV-VER-002, INV-VER-010: submitted revisions cannot be rewritten';

create function assert_content_revision_version_editable() returns trigger
language plpgsql
as $$
declare
  version_state version_lifecycle;
begin
  select lifecycle_state
    into version_state
    from document_version
   where tenant_id = new.tenant_id
     and id = new.document_version_id;

  if version_state is distinct from 'DRAFT' then
    raise exception using
      errcode = '23514',
      constraint = 'content_revision_version_editable',
      message = 'content revisions may be created or edited only while the version is DRAFT';
  end if;
  return new;
end
$$;

comment on function assert_content_revision_version_editable() is
  'INV-VER-004: content cannot be created or edited while review is active';

create trigger content_revision_version_editable
  before insert or update on content_revision
  for each row execute function assert_content_revision_version_editable();

comment on trigger content_revision_version_editable on content_revision is
  'INV-VER-004: only a DRAFT version accepts content revision writes';

create function assert_content_attachment_editable() returns trigger
language plpgsql
as $$
declare
  attachment_editable boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select revision.submitted_at is null and version.lifecycle_state = 'DRAFT'
      into attachment_editable
      from content_revision revision
      join document_version version
        on version.tenant_id = revision.tenant_id
       and version.id = revision.document_version_id
     where revision.tenant_id = old.tenant_id
       and revision.id = old.content_revision_id;

    if attachment_editable is distinct from true then
      raise exception using
        errcode = '23514',
        constraint = 'content_attachment_immutable_after_submission',
        message = 'a submitted or in-review attachment set is immutable';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select revision.submitted_at is null and version.lifecycle_state = 'DRAFT'
      into attachment_editable
      from content_revision revision
      join document_version version
        on version.tenant_id = revision.tenant_id
       and version.id = revision.document_version_id
     where revision.tenant_id = new.tenant_id
       and revision.id = new.content_revision_id;

    if attachment_editable is distinct from true then
      raise exception using
        errcode = '23514',
        constraint = 'content_attachment_immutable_after_submission',
        message = 'a submitted or in-review attachment set is immutable';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

comment on function assert_content_attachment_editable() is
  'INV-VER-002, INV-VER-004, INV-VER-010, INV-VER-013: attachment changes are limited to unsubmitted DRAFT revisions';

create trigger content_attachment_editable_before_submission
  before insert or update or delete on content_attachment
  for each row execute function assert_content_attachment_editable();

comment on trigger content_attachment_editable_before_submission on content_attachment is
  'INV-VER-002, INV-VER-004, INV-VER-010, INV-VER-013: the submitted attachment set is frozen';

create trigger enforce_row_version before update on content_revision
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on content_attachment
  for each row execute function enforce_row_version();

-- Resolve the forward reference left by POL-013. The tenant coordinate prevents a
-- submitted revision from another tenant becoming the version's approval target.
alter table document_version no force row level security;
alter table document_version
  add constraint document_version_approved_revision_fk
  foreign key (tenant_id, approved_revision_id)
  references content_revision (tenant_id, id)
  on delete restrict
  not valid;
alter table document_version validate constraint document_version_approved_revision_fk;
alter table document_version force row level security;

comment on constraint document_version_approved_revision_fk on document_version is
  'INV-TEN-003, INV-VER-002, INV-DOC-004: the frozen revision target is tenant-contained and retained';

alter table content_revision enable row level security;
alter table content_revision force row level security;
create policy tenant_isolation on content_revision
  using (tenant_id = current_setting('app.tenant_id')::uuid);

alter table content_attachment enable row level security;
alter table content_attachment force row level security;
create policy tenant_isolation on content_attachment
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on content_revision is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: content-revision isolation fails closed';
comment on policy tenant_isolation on content_attachment is
  'INV-TEN-001, INV-TEN-002, INV-TEN-004, INV-TEN-005: attachment isolation fails closed';

grant select, insert, update on content_revision to app_role;
revoke delete, truncate on content_revision from app_role;
grant select, insert, update, delete on content_attachment to app_role;
revoke truncate on content_attachment from app_role;
