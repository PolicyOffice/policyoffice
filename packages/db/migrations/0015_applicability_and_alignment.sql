-- POL-018: dated applicability facts and durable alignment obligations.

create type inheritance_mode as enum ('MANDATORY', 'DEFAULT', 'LOCAL_ONLY');

create table applicability_rule (
  tenant_id                 uuid not null,
  id                        uuid not null default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  row_version               integer not null default 1,
  document_variant_id       uuid not null,
  authorised_by_version_id  uuid,
  effect                    text not null,
  legal_entity_ids          uuid[] not null default '{}'::uuid[],
  org_unit_ids              uuid[] not null default '{}'::uuid[],
  jurisdiction_ids          uuid[] not null default '{}'::uuid[],
  group_ids                 uuid[] not null default '{}'::uuid[],
  user_ids                  uuid[] not null default '{}'::uuid[],
  inheritance_mode          inheritance_mode not null,
  validity                  tstzrange not null,
  constraint applicability_rule_pkey primary key (tenant_id, id),
  constraint applicability_rule_id_unique unique (id),
  constraint applicability_rule_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint applicability_rule_variant_fk
    foreign key (tenant_id, document_variant_id)
    references document_variant (tenant_id, id) on delete restrict,
  constraint applicability_rule_authorised_version_fk
    foreign key (tenant_id, authorised_by_version_id)
    references document_version (tenant_id, id) on delete restrict,
  constraint applicability_rule_effect_supported check (effect in ('INCLUDE', 'EXCLUDE')),
  constraint applicability_rule_validity_half_open check (
    not isempty(validity) and lower_inc(validity) and not upper_inc(validity)
  )
);

create table alignment_obligation (
  tenant_id                 uuid not null,
  id                        uuid not null default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  row_version               integer not null default 1,
  subject_type              text not null,
  subject_id                uuid not null,
  source_version_id         uuid not null,
  raised_at                 timestamptz not null,
  due_at                    timestamptz,
  reason                    text not null,
  status                    text not null,
  resolved_by               uuid,
  resolved_at               timestamptz,
  resolution_note           text,
  resolving_review_case_id  uuid,
  constraint alignment_obligation_pkey primary key (tenant_id, id),
  constraint alignment_obligation_id_unique unique (id),
  constraint alignment_obligation_tenant_fk foreign key (tenant_id)
    references tenant (id) on delete restrict,
  constraint alignment_obligation_source_version_fk
    foreign key (tenant_id, source_version_id)
    references document_version (tenant_id, id) on delete restrict,
  constraint alignment_obligation_resolved_by_fk
    foreign key (tenant_id, resolved_by)
    references app_user (tenant_id, id) on delete restrict,
  constraint alignment_obligation_subject_supported check (
    subject_type in ('DOCUMENT_VARIANT', 'DOCUMENT_TYPE')
  ),
  constraint alignment_obligation_reason_not_blank check (
    nullif(btrim(reason), '') is not null
  ),
  constraint alignment_obligation_status_supported check (status in ('OPEN', 'RESOLVED')),
  constraint alignment_obligation_resolution_consistent check (
    (
      status = 'OPEN'
      and resolved_by is null
      and resolved_at is null
      and resolution_note is null
      and resolving_review_case_id is null
    )
    or
    (
      status = 'RESOLVED'
      and resolved_by is not null
      and resolved_at is not null
      and nullif(btrim(resolution_note), '') is not null
    )
  )
);

create index applicability_rule_variant_idx
  on applicability_rule (tenant_id, document_variant_id);
create index applicability_rule_authorised_version_idx
  on applicability_rule (tenant_id, authorised_by_version_id);
create index applicability_rule_validity_idx
  on applicability_rule using gist (tenant_id, validity);

create index alignment_obligation_subject_idx
  on alignment_obligation (tenant_id, subject_type, subject_id);
create index alignment_obligation_source_version_idx
  on alignment_obligation (tenant_id, source_version_id);
create index alignment_obligation_resolved_by_idx
  on alignment_obligation (tenant_id, resolved_by);
create index alignment_obligation_open_due_idx
  on alignment_obligation (tenant_id, due_at)
  where status = 'OPEN';

-- PostgreSQL arrays cannot carry composite foreign keys. Validate every target against
-- the rule tenant so a UUID obtained from another tenant behaves exactly like not-found.
create function assert_applicability_rule_targets() returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from unnest(new.legal_entity_ids) as requested(id)
      left join legal_entity target
        on target.tenant_id = new.tenant_id and target.id = requested.id
     where target.id is null
  ) then
    raise exception 'applicability rule contains a legal entity outside its tenant'
      using errcode = '23503', constraint = 'applicability_rule_legal_entity_tenant_fk';
  end if;

  if exists (
    select 1
      from unnest(new.org_unit_ids) as requested(id)
      left join org_unit target
        on target.tenant_id = new.tenant_id and target.id = requested.id
     where target.id is null
  ) then
    raise exception 'applicability rule contains an org unit outside its tenant'
      using errcode = '23503', constraint = 'applicability_rule_org_unit_tenant_fk';
  end if;

  if exists (
    select 1
      from unnest(new.jurisdiction_ids) as requested(id)
      left join jurisdiction target
        on target.tenant_id = new.tenant_id and target.id = requested.id
     where target.id is null
  ) then
    raise exception 'applicability rule contains a jurisdiction outside its tenant'
      using errcode = '23503', constraint = 'applicability_rule_jurisdiction_tenant_fk';
  end if;

  if exists (
    select 1
      from unnest(new.group_ids) as requested(id)
      left join user_group target
        on target.tenant_id = new.tenant_id and target.id = requested.id
     where target.id is null
  ) then
    raise exception 'applicability rule contains a group outside its tenant'
      using errcode = '23503', constraint = 'applicability_rule_group_tenant_fk';
  end if;

  if exists (
    select 1
      from unnest(new.user_ids) as requested(id)
      left join app_user target
        on target.tenant_id = new.tenant_id and target.id = requested.id
     where target.id is null
  ) then
    raise exception 'applicability rule contains a user outside its tenant'
      using errcode = '23503', constraint = 'applicability_rule_user_tenant_fk';
  end if;

  return new;
end;
$$;

comment on function assert_applicability_rule_targets() is
  'INV-TEN-003: every explicit applicability target is tenant-contained';

create trigger enforce_applicability_rule_targets
  before insert or update of tenant_id, legal_entity_ids, org_unit_ids,
    jurisdiction_ids, group_ids, user_ids on applicability_rule
  for each row execute function assert_applicability_rule_targets();

comment on trigger enforce_applicability_rule_targets on applicability_rule is
  'INV-TEN-003: UUID-array targets cannot reference another tenant';

-- Rule changes and version lifecycle transitions serialize on one variant. This closes
-- both the nullable-draft submission race and the approval-freeze race.
create function lock_applicability_rule_set() returns trigger
language plpgsql
as $$
declare
  first_variant_id uuid := new.document_variant_id;
  second_variant_id uuid;
begin
  if tg_table_name = 'applicability_rule'
     and tg_op = 'UPDATE'
     and old.document_variant_id is distinct from new.document_variant_id then
    if old.document_variant_id::text < new.document_variant_id::text then
      first_variant_id := old.document_variant_id;
      second_variant_id := new.document_variant_id;
    else
      second_variant_id := old.document_variant_id;
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':applicability:' || first_variant_id::text, 0)
  );
  if second_variant_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(new.tenant_id::text || ':applicability:' || second_variant_id::text, 0)
    );
  end if;
  return new;
end;
$$;

comment on function lock_applicability_rule_set() is
  'INV-VER-007: serializes rule changes with lifecycle transitions that capture or freeze them';

create trigger acquire_applicability_rule_change_lock
  before insert or update on applicability_rule
  for each row execute function lock_applicability_rule_set();

comment on trigger acquire_applicability_rule_change_lock on applicability_rule is
  'INV-VER-007: a submitted version cannot miss a concurrent draft applicability change';

create trigger acquire_document_version_applicability_lock
  before update of lifecycle_state on document_version
  for each row
  when (old.lifecycle_state is distinct from new.lifecycle_state)
  execute function lock_applicability_rule_set();

comment on trigger acquire_document_version_applicability_lock on document_version is
  'INV-VER-007: submission captures and approval freezes one serialized applicability rule set';

-- A draft may exist before it has a submitted version to cite. Once a rule has provenance,
-- that version must be the pre-release candidate for the same variant. An unchanged
-- provenance reference remains valid later so an approved rule can be closed.
create function assert_applicability_rule_authority() returns trigger
language plpgsql
as $$
declare
  authority_state version_lifecycle;
  authority_variant_id uuid;
begin
  if new.authorised_by_version_id is null then
    select version.lifecycle_state
      into authority_state
      from document_version version
     where version.tenant_id = new.tenant_id
       and version.document_variant_id = new.document_variant_id
       and version.lifecycle_state = 'DRAFT'
     limit 1
     for share;
    if not found then
      raise exception 'only a draft applicability rule may omit its authorising version'
        using errcode = '23514', constraint = 'applicability_rule_authority_required';
    end if;
    return new;
  end if;

  select version.lifecycle_state, version.document_variant_id
    into authority_state, authority_variant_id
    from document_version version
   where version.tenant_id = new.tenant_id
     and version.id = new.authorised_by_version_id
   for share;

  if not found then
    raise exception 'applicability rule authorising version was not found in its tenant'
      using errcode = '23503', constraint = 'applicability_rule_authorised_version_fk';
  end if;

  if authority_variant_id is distinct from new.document_variant_id then
    raise exception 'applicability rule authorising version belongs to another variant'
      using errcode = '23514', constraint = 'applicability_rule_authority_variant';
  end if;

  if (
    tg_op = 'INSERT'
    or new.authorised_by_version_id is distinct from old.authorised_by_version_id
    or new.document_variant_id is distinct from old.document_variant_id
  ) and authority_state not in ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED') then
    raise exception 'a released or terminal version cannot authorise a new applicability fact'
      using errcode = '23514', constraint = 'applicability_rule_authority_mutable';
  end if;

  return new;
end;
$$;

comment on function assert_applicability_rule_authority() is
  'INV-VER-007: every submitted rule interval cites the same-variant version whose approver relied on it';

create trigger enforce_applicability_rule_authority
  before insert or update of tenant_id, document_variant_id, authorised_by_version_id
  on applicability_rule
  for each row execute function assert_applicability_rule_authority();

comment on trigger enforce_applicability_rule_authority on applicability_rule is
  'INV-TEN-003, INV-VER-007: rule provenance is tenant-contained, variant-matched and captured before approval';

create function authorise_submitted_applicability_rules() returns trigger
language plpgsql
as $$
begin
  update applicability_rule
     set authorised_by_version_id = new.id,
         updated_at = statement_timestamp(),
         row_version = row_version + 1
   where tenant_id = new.tenant_id
     and document_variant_id = new.document_variant_id
     and authorised_by_version_id is null;
  return new;
end;
$$;

comment on function authorise_submitted_applicability_rules() is
  'INV-VER-007: DRAFT to IN_REVIEW captures the authorising version on every draft rule';

create trigger authorise_submitted_applicability_rules
  after update of lifecycle_state on document_version
  for each row
  when (old.lifecycle_state = 'DRAFT' and new.lifecycle_state = 'IN_REVIEW')
  execute function authorise_submitted_applicability_rules();

comment on trigger authorise_submitted_applicability_rules on document_version is
  'INV-VER-007: version submission makes applicability provenance durable';

-- Ended rules are historical facts. Once the authorising version is frozen, an open rule
-- may only acquire an upper bound; correcting scope means close-and-append under a new
-- version rather than rewriting what an approver saw.
create function protect_applicability_rule_history() returns trigger
language plpgsql
as $$
declare
  authority_is_frozen boolean := false;
begin
  if not upper_inf(old.validity) then
    raise exception 'ended applicability rules are immutable'
      using errcode = '55000', constraint = 'applicability_rule_history_immutable';
  end if;

  if old.authorised_by_version_id is not null then
    select lifecycle_state in (
      'APPROVED', 'PUBLISHED', 'EFFECTIVE', 'SUPERSEDED',
      'WITHDRAWN', 'REJECTED', 'CANCELLED'
    )
      into authority_is_frozen
     from document_version
     where tenant_id = old.tenant_id
       and id = old.authorised_by_version_id
     for share;
  end if;

  if authority_is_frozen
     and (
       new.tenant_id is distinct from old.tenant_id
       or new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or new.document_variant_id is distinct from old.document_variant_id
       or new.authorised_by_version_id is distinct from old.authorised_by_version_id
       or new.effect is distinct from old.effect
       or new.legal_entity_ids is distinct from old.legal_entity_ids
       or new.org_unit_ids is distinct from old.org_unit_ids
       or new.jurisdiction_ids is distinct from old.jurisdiction_ids
       or new.group_ids is distinct from old.group_ids
       or new.user_ids is distinct from old.user_ids
       or new.inheritance_mode is distinct from old.inheritance_mode
       or lower(new.validity) is distinct from lower(old.validity)
       or lower_inc(new.validity) is distinct from lower_inc(old.validity)
       or upper_inf(new.validity)
     ) then
    raise exception 'an approved applicability rule may only be ended'
      using errcode = '55000', constraint = 'applicability_rule_approved_immutable';
  end if;

  return new;
end;
$$;

comment on function protect_applicability_rule_history() is
  'INV-VER-007, INV-TIME-005: approved applicability is corrected by closing and appending half-open facts';

create trigger protect_applicability_rule_history
  before update on applicability_rule
  for each row execute function protect_applicability_rule_history();

comment on trigger protect_applicability_rule_history on applicability_rule is
  'INV-VER-007: ended rules are immutable and approved rules may only be closed';

-- subject_id is intentionally polymorphic. Validate the selected subject table under the
-- caller's tenant context rather than giving this trigger elevated visibility.
create function assert_alignment_obligation_subject() returns trigger
language plpgsql
as $$
begin
  if new.subject_type = 'DOCUMENT_VARIANT' then
    if not exists (
      select 1 from document_variant
       where tenant_id = new.tenant_id and id = new.subject_id
    ) then
      raise exception 'alignment subject variant was not found in its tenant'
        using errcode = '23503', constraint = 'alignment_obligation_subject_tenant_fk';
    end if;
  elsif new.subject_type = 'DOCUMENT_TYPE' then
    if not exists (
      select 1 from document_type
       where tenant_id = new.tenant_id and id = new.subject_id
    ) then
      raise exception 'alignment subject document type was not found in its tenant'
        using errcode = '23503', constraint = 'alignment_obligation_subject_tenant_fk';
    end if;
  else
    raise exception 'unsupported alignment subject type'
      using errcode = '23514', constraint = 'alignment_obligation_subject_supported';
  end if;
  return new;
end;
$$;

comment on function assert_alignment_obligation_subject() is
  'INV-TEN-003, INV-APL-008: every durable alignment subject is tenant-contained';

create trigger enforce_alignment_obligation_subject
  before insert or update of tenant_id, subject_type, subject_id on alignment_obligation
  for each row execute function assert_alignment_obligation_subject();

comment on trigger enforce_alignment_obligation_subject on alignment_obligation is
  'INV-TEN-003: a polymorphic alignment subject cannot reference another tenant';

create trigger enforce_row_version before update on applicability_rule
  for each row execute function enforce_row_version();
create trigger enforce_row_version before update on alignment_obligation
  for each row execute function enforce_row_version();

comment on trigger enforce_row_version on applicability_rule is
  'INV-TIME-003: stale applicability writes conflict instead of overwriting governed scope';
comment on trigger enforce_row_version on alignment_obligation is
  'INV-TIME-003: stale alignment writes conflict instead of overwriting governance action';

comment on constraint applicability_rule_pkey on applicability_rule is
  'INV-TEN-003: composite identity for a tenant-owned applicability rule';
comment on constraint applicability_rule_id_unique on applicability_rule is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint applicability_rule_tenant_fk on applicability_rule is
  'INV-TEN-003: every applicability rule is anchored to its tenant';
comment on constraint applicability_rule_variant_fk on applicability_rule is
  'INV-TEN-003, INV-APL-010: applicability belongs to a retained tenant variant, never a Space';
comment on constraint applicability_rule_authorised_version_fk on applicability_rule is
  'INV-TEN-003, INV-VER-007: the retained authorising version is tenant-contained';
comment on constraint applicability_rule_effect_supported on applicability_rule is
  'INV-VER-007: include or exclude is an explicit governed applicability fact';
comment on constraint applicability_rule_validity_half_open on applicability_rule is
  'INV-TIME-005: rule validity is a non-empty half-open interval';

comment on constraint alignment_obligation_pkey on alignment_obligation is
  'INV-TEN-003: composite identity for a tenant-owned alignment obligation';
comment on constraint alignment_obligation_id_unique on alignment_obligation is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint alignment_obligation_tenant_fk on alignment_obligation is
  'INV-TEN-003: every alignment obligation is anchored to its tenant';
comment on constraint alignment_obligation_source_version_fk on alignment_obligation is
  'INV-TEN-003, INV-APL-008: the upstream version that raised alignment is retained';
comment on constraint alignment_obligation_resolved_by_fk on alignment_obligation is
  'INV-TEN-003, INV-APL-008: resolution identifies a retained tenant user';
comment on constraint alignment_obligation_subject_supported on alignment_obligation is
  'INV-APL-008: obligations name the downstream variant or document type requiring action';
comment on constraint alignment_obligation_reason_not_blank on alignment_obligation is
  'INV-APL-008: a durable alignment obligation records why action is required';
comment on constraint alignment_obligation_status_supported on alignment_obligation is
  'INV-APL-008: alignment has only open and explicitly resolved states';
comment on constraint alignment_obligation_resolution_consistent on alignment_obligation is
  'INV-APL-008, INV-APL-013: resolution requires recorded human action; deadlines never resolve';

comment on column alignment_obligation.resolving_review_case_id is
  'INV-APL-008: forward reference; the review-case migration adds the composite foreign key';

alter table applicability_rule enable row level security;
alter table applicability_rule force row level security;
create policy tenant_isolation on applicability_rule
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on applicability_rule is
  'INV-TEN-001, INV-TEN-003: applicability isolation fails closed';

alter table alignment_obligation enable row level security;
alter table alignment_obligation force row level security;
create policy tenant_isolation on alignment_obligation
  using (tenant_id = current_setting('app.tenant_id')::uuid);

comment on policy tenant_isolation on alignment_obligation is
  'INV-TEN-001, INV-TEN-003: alignment isolation fails closed';

grant usage on type inheritance_mode to app_role;
grant select, insert, update on applicability_rule, alignment_obligation to app_role;
revoke delete, truncate on applicability_rule, alignment_obligation from app_role;
