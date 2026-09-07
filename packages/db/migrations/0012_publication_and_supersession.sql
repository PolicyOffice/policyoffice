-- POL-016: atomic publication, supersession and withdrawal.

-- Decision Request #81 permits one tightly bounded exception to the write-once upper
-- bound: withdrawal may shorten prospective governance, but can never move the start or
-- rewrite time that has already elapsed.
create or replace function assert_governed_columns_unchanged() returns trigger
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
  effective_from_changed boolean :=
    new.effective_from is distinct from old.effective_from;
  effective_until_changed boolean :=
    new.effective_until is distinct from old.effective_until;
  controlled_withdrawal_shortening boolean :=
    current_user = 'migration_role'
    and old.lifecycle_state in ('PUBLISHED', 'EFFECTIVE')
    and new.lifecycle_state = 'WITHDRAWN'
    and new.effective_from is not null
    and new.effective_until is not null
    and new.effective_until >= new.effective_from
    and (old.effective_until is null or new.effective_until <= old.effective_until)
    and (
      (old.lifecycle_state = 'PUBLISHED' and new.effective_until = new.effective_from)
      or (
        old.lifecycle_state = 'EFFECTIVE'
        and new.effective_until = transaction_timestamp()
      )
    );
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

  if effective_from_changed
     and (
       current_user <> 'migration_role'
       or old.effective_from is not null
     ) then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_governed_columns_immutable',
      message = 'effective_from may be assigned once only by the controlled publication path';
  end if;

  if effective_until_changed
     and not (
       controlled_withdrawal_shortening
       or (
         current_user = 'migration_role'
         and old.effective_until is null
         and new.lifecycle_state <> 'WITHDRAWN'
       )
     ) then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_governed_columns_immutable',
      message = 'effective_until may only be assigned once or shortened by controlled withdrawal';
  end if;

  return new;
end
$$;

comment on function assert_governed_columns_unchanged() is
  'INV-VER-003, INV-VER-007: freezes governed fields; Decision Request #81 permits only controlled withdrawal to shorten a prospective upper bound';

-- INV-DOC-007: PLANNED -> ACTIVE remains unavailable to app_role updates. The sole
-- migration-owned publication function below derives it from immediate effectivity.
create or replace function enforce_document_lifecycle_transition() returns trigger
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
        and not (
          old.lifecycle_status = 'PLANNED'
          and (
            new.lifecycle_status = 'RETIRED'
            or (new.lifecycle_status = 'ACTIVE' and current_user = 'migration_role')
          )
        ) then
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
  'INV-DOC-002, INV-DOC-007: ACTIVE is reachable only as a migration-owned derivation of first effectivity';

create function publish_document_version(
  p_tenant_id uuid,
  p_version_id uuid,
  p_expected_row_version integer,
  p_effective_from timestamptz,
  p_published_at timestamptz
) returns table (
  version_id uuid,
  document_id uuid,
  document_variant_id uuid,
  configuration_version_id uuid,
  lifecycle_state version_lifecycle,
  published_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  row_version integer,
  immediate boolean,
  predecessor_version_id uuid,
  predecessor_previous_state version_lifecycle,
  predecessor_previous_until timestamptz,
  predecessor_row_version integer,
  document_activated boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_variant_id uuid;
  v_document_id uuid;
  v_configuration_version_id uuid;
  v_lifecycle_state version_lifecycle;
  v_row_version integer;
  v_later_effective_from timestamptz;
  v_predecessor_id uuid;
  v_predecessor_state version_lifecycle;
  v_predecessor_until timestamptz;
  v_predecessor_row_version integer;
  v_immediate boolean;
  v_document_activated boolean := false;
begin
  if p_expected_row_version is null or p_expected_row_version < 1 then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_expected_row_version_positive',
      message = 'expected row_version must be positive';
  end if;
  if p_effective_from is null or p_published_at is null then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_publication_instant_required',
      message = 'publication and effectivity instants are required';
  end if;
  if p_effective_from < p_published_at then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_retroactive_publication_unsupported',
      message = 'retroactive publication is not supported';
  end if;

  -- Resolve only the serialization key before taking a lock. FORCE RLS keeps this lookup
  -- tenant-contained even though the function executes as migration_role.
  select candidate.document_variant_id
    into v_variant_id
    from public.document_version candidate
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;
  if not found then
    return;
  end if;

  perform 1
    from public.document_variant variant
   where variant.tenant_id = p_tenant_id
     and variant.id = v_variant_id
   for update;
  if not found then
    return;
  end if;

  select variant.document_id,
         candidate.configuration_version_id,
         candidate.lifecycle_state,
         candidate.row_version
    into v_document_id,
         v_configuration_version_id,
         v_lifecycle_state,
         v_row_version
    from public.document_version candidate
    join public.document_variant variant
      on variant.tenant_id = candidate.tenant_id
     and variant.id = candidate.document_variant_id
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id
   for update of candidate;
  if not found then
    return;
  end if;

  if v_row_version <> p_expected_row_version then
    raise exception using
      errcode = '40001',
      constraint = 'document_version_row_version_current',
      message = 'document version row_version is stale';
  end if;
  if v_lifecycle_state <> 'APPROVED' then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_publication_lifecycle',
      message = 'only an APPROVED document version may be published';
  end if;

  v_immediate := p_effective_from = p_published_at;

  select later.effective_from
    into v_later_effective_from
    from public.document_version later
   where later.tenant_id = p_tenant_id
     and later.document_variant_id = v_variant_id
     and later.id <> p_version_id
     and later.effective_from > p_effective_from
     and later.effective_range is not null
     and not isempty(later.effective_range)
     and later.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
   order by later.effective_from
   limit 1;

  select predecessor.id,
         predecessor.lifecycle_state,
         predecessor.effective_until
    into v_predecessor_id,
         v_predecessor_state,
         v_predecessor_until
    from public.document_version predecessor
   where predecessor.tenant_id = p_tenant_id
     and predecessor.document_variant_id = v_variant_id
     and predecessor.id <> p_version_id
     and predecessor.effective_from < p_effective_from
     and predecessor.effective_range @> p_effective_from
     and predecessor.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
   order by predecessor.effective_from desc
   limit 1
   for update;

  -- The exclusion constraint is immediate, so close the locked predecessor before
  -- claiming the successor. Both changes remain atomic at the transaction boundary.
  if v_predecessor_id is not null then
    update public.document_version predecessor
       set effective_until = p_effective_from,
           superseded_by_version_id = p_version_id,
           row_version = predecessor.row_version + 1
     where predecessor.tenant_id = p_tenant_id
       and predecessor.id = v_predecessor_id
     returning predecessor.row_version into v_predecessor_row_version;
  end if;

  update public.document_version candidate
     set lifecycle_state = 'PUBLISHED',
         published_at = p_published_at,
         effective_from = p_effective_from,
         effective_until = v_later_effective_from,
         row_version = candidate.row_version + 1
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;

  if v_immediate then
    if v_predecessor_id is not null then
      if v_predecessor_state <> 'EFFECTIVE' then
        raise exception using
          errcode = '23514',
          constraint = 'document_version_predecessor_lifecycle',
          message = 'an immediate predecessor must be EFFECTIVE';
      end if;
      update public.document_version predecessor
         set lifecycle_state = 'SUPERSEDED',
             row_version = predecessor.row_version + 1
       where predecessor.tenant_id = p_tenant_id
         and predecessor.id = v_predecessor_id
       returning predecessor.row_version into v_predecessor_row_version;
    end if;

    update public.document_version candidate
       set lifecycle_state = 'EFFECTIVE',
           row_version = candidate.row_version + 1
     where candidate.tenant_id = p_tenant_id
       and candidate.id = p_version_id;

    update public.document governed_document
       set lifecycle_status = 'ACTIVE',
           row_version = governed_document.row_version + 1
     where governed_document.tenant_id = p_tenant_id
       and governed_document.id = v_document_id
       and governed_document.lifecycle_status = 'PLANNED';
    v_document_activated := found;
  end if;

  return query
  select candidate.id,
         v_document_id,
         candidate.document_variant_id,
         candidate.configuration_version_id,
         candidate.lifecycle_state,
         candidate.published_at,
         candidate.effective_from,
         candidate.effective_until,
         candidate.row_version,
         v_immediate,
         v_predecessor_id,
         v_predecessor_state,
         v_predecessor_until,
         v_predecessor_row_version,
         v_document_activated
    from public.document_version candidate
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;
end
$$;

comment on function publish_document_version(uuid, uuid, integer, timestamptz, timestamptz) is
  'INV-EFF-001, INV-EFF-002, INV-EFF-003, INV-DOC-007, INV-TIME-003, INV-TIME-005: the narrow tenant-scoped publication and immediate-effectivity transaction';

create function withdraw_document_version(
  p_tenant_id uuid,
  p_version_id uuid,
  p_expected_row_version integer,
  p_withdrawal_reason text
) returns table (
  version_id uuid,
  document_id uuid,
  document_variant_id uuid,
  configuration_version_id uuid,
  previous_lifecycle_state version_lifecycle,
  lifecycle_state version_lifecycle,
  effective_from timestamptz,
  previous_effective_until timestamptz,
  effective_until timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  row_version integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_variant_id uuid;
  v_document_id uuid;
  v_configuration_version_id uuid;
  v_lifecycle_state version_lifecycle;
  v_effective_from timestamptz;
  v_effective_until timestamptz;
  v_row_version integer;
  v_withdrawn_at timestamptz := transaction_timestamp();
  v_new_effective_until timestamptz;
begin
  if p_expected_row_version is null or p_expected_row_version < 1 then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_expected_row_version_positive',
      message = 'expected row_version must be positive';
  end if;
  if nullif(btrim(p_withdrawal_reason), '') is null then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_withdrawal_reason_required',
      message = 'withdrawal reason is required';
  end if;

  select candidate.document_variant_id
    into v_variant_id
    from public.document_version candidate
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;
  if not found then
    return;
  end if;

  perform 1
    from public.document_variant variant
   where variant.tenant_id = p_tenant_id
     and variant.id = v_variant_id
   for update;
  if not found then
    return;
  end if;

  select variant.document_id,
         candidate.configuration_version_id,
         candidate.lifecycle_state,
         candidate.effective_from,
         candidate.effective_until,
         candidate.row_version
    into v_document_id,
         v_configuration_version_id,
         v_lifecycle_state,
         v_effective_from,
         v_effective_until,
         v_row_version
    from public.document_version candidate
    join public.document_variant variant
      on variant.tenant_id = candidate.tenant_id
     and variant.id = candidate.document_variant_id
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id
   for update of candidate;
  if not found then
    return;
  end if;

  if v_row_version <> p_expected_row_version then
    raise exception using
      errcode = '40001',
      constraint = 'document_version_row_version_current',
      message = 'document version row_version is stale';
  end if;
  if v_lifecycle_state not in ('PUBLISHED', 'EFFECTIVE') then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_withdrawal_lifecycle',
      message = 'only a PUBLISHED or EFFECTIVE document version may be withdrawn';
  end if;
  if v_effective_from is null then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_withdrawal_effectivity',
      message = 'a released document version must have an effective_from instant';
  end if;

  if v_lifecycle_state = 'PUBLISHED' then
    v_new_effective_until := v_effective_from;
  else
    if v_withdrawn_at < v_effective_from then
      raise exception using
        errcode = '23514',
        constraint = 'document_version_withdrawal_effectivity',
        message = 'an EFFECTIVE version cannot be withdrawn before its effective_from';
    end if;
    v_new_effective_until := v_withdrawn_at;
  end if;

  update public.document_version candidate
     set lifecycle_state = 'WITHDRAWN',
         effective_until = v_new_effective_until,
         withdrawn_at = v_withdrawn_at,
         withdrawal_reason = btrim(p_withdrawal_reason),
         row_version = candidate.row_version + 1
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;

  return query
  select candidate.id,
         v_document_id,
         candidate.document_variant_id,
         candidate.configuration_version_id,
         v_lifecycle_state,
         candidate.lifecycle_state,
         candidate.effective_from,
         v_effective_until,
         candidate.effective_until,
         candidate.withdrawn_at,
         candidate.withdrawal_reason,
         candidate.row_version
    from public.document_version candidate
   where candidate.tenant_id = p_tenant_id
     and candidate.id = p_version_id;
end
$$;

comment on function withdraw_document_version(uuid, uuid, integer, text) is
  'INV-EFF-004, INV-VER-005, INV-VER-007, INV-TIME-003: controlled withdrawal preserves elapsed governance and never resurrects history';

revoke all on function publish_document_version(uuid, uuid, integer, timestamptz, timestamptz)
  from public;
revoke all on function withdraw_document_version(uuid, uuid, integer, text)
  from public;
grant execute on function publish_document_version(uuid, uuid, integer, timestamptz, timestamptz)
  to app_role;
grant execute on function withdraw_document_version(uuid, uuid, integer, text)
  to app_role;
