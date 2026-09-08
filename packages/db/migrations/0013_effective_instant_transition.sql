-- POL-017: idempotent effective-instant lifecycle narration.

create function transition_document_version_effective(
  p_tenant_id uuid,
  p_version_id uuid,
  p_instant timestamptz
) returns table (
  transition_outcome text,
  version_id uuid,
  document_id uuid,
  document_variant_id uuid,
  configuration_version_id uuid,
  previous_lifecycle_state version_lifecycle,
  lifecycle_state version_lifecycle,
  effective_from timestamptz,
  effective_until timestamptz,
  row_version integer,
  predecessor_version_id uuid,
  predecessor_previous_state version_lifecycle,
  predecessor_effective_until timestamptz,
  predecessor_row_version integer,
  document_activated boolean,
  policy_gap boolean,
  policy_gap_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_variant_id uuid;
  v_document_id uuid;
  v_configuration_version_id uuid;
  v_previous_state version_lifecycle;
  v_lifecycle_state version_lifecycle;
  v_effective_from timestamptz;
  v_effective_until timestamptz;
  v_withdrawn_at timestamptz;
  v_row_version integer;
  v_outcome text;
  v_predecessor_id uuid;
  v_predecessor_state version_lifecycle;
  v_predecessor_until timestamptz;
  v_predecessor_row_version integer;
  v_document_activated boolean := false;
  v_policy_gap boolean := false;
  v_policy_gap_at timestamptz;
  v_gap_dedupe_key text;
begin
  if p_instant is null then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_effective_instant_required',
      message = 'effective-instant transition requires an instant';
  end if;
  if p_instant > transaction_timestamp() then
    raise exception using
      errcode = '22023',
      constraint = 'document_version_effective_instant_not_future',
      message = 'effective-instant transition cannot narrate a future instant';
  end if;

  -- Resolve only the serialization key before locking. FORCE RLS continues to bind the
  -- migration_role owner, so a cross-tenant identifier remains indistinguishable from a
  -- missing one and an absent tenant context fails closed.
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

  -- The job payload carries only identity and a processing instant. Every lifecycle and
  -- interval fact used below is re-read after the variant lock.
  select variant.document_id,
         candidate.configuration_version_id,
         candidate.lifecycle_state,
         candidate.effective_from,
         candidate.effective_until,
         candidate.withdrawn_at,
         candidate.row_version
    into v_document_id,
         v_configuration_version_id,
         v_previous_state,
         v_effective_from,
         v_effective_until,
         v_withdrawn_at,
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

  v_lifecycle_state := v_previous_state;

  if v_previous_state = 'CANCELLED' then
    v_outcome := 'CANCELLED';
  elsif v_previous_state in ('EFFECTIVE', 'SUPERSEDED') then
    v_outcome := 'ALREADY_TRANSITIONED';
  elsif v_previous_state = 'WITHDRAWN' then
    -- Transition 10 produces an empty interval whose gap begins at effective_from.
    -- Transition 12 closes at withdrawn_at. Both values are authoritative database facts.
    if v_effective_until = v_effective_from then
      v_policy_gap_at := v_effective_from;
    else
      v_policy_gap_at := v_withdrawn_at;
    end if;

    -- A non-empty interval proves the version had already become effective before it
    -- was withdrawn, so its gap is due by construction. For an empty scheduled interval,
    -- retain the processing-instant check and do not narrate a future gap early.
    if v_policy_gap_at is null
       or (v_effective_until = v_effective_from and p_instant < v_policy_gap_at) then
      v_outcome := 'NOT_DUE';
      v_policy_gap_at := null;
    else
      v_outcome := 'WITHDRAWN';
      v_gap_dedupe_key := format('governance.policy_gap:%s', p_version_id);
      v_policy_gap := not exists (
        select 1
          from public.document_version holder
         where holder.tenant_id = p_tenant_id
           and holder.document_variant_id = v_variant_id
           and holder.effective_range @> v_policy_gap_at
           and holder.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
      ) and not exists (
        select 1
          from public.audit_event event
         where event.tenant_id = p_tenant_id
           and event.dedupe_key = v_gap_dedupe_key
      );
    end if;
  elsif v_previous_state <> 'PUBLISHED' or v_effective_from is null then
    v_outcome := 'INELIGIBLE';
  elsif p_instant < v_effective_from then
    v_outcome := 'NOT_DUE';
  else
    select predecessor.id,
           predecessor.lifecycle_state,
           predecessor.effective_until,
           predecessor.row_version
      into v_predecessor_id,
           v_predecessor_state,
           v_predecessor_until,
           v_predecessor_row_version
      from public.document_version predecessor
     where predecessor.tenant_id = p_tenant_id
       and predecessor.document_variant_id = v_variant_id
       and predecessor.superseded_by_version_id = p_version_id
     order by predecessor.effective_from desc
     limit 1
     for update;

    if v_predecessor_id is not null and v_predecessor_state = 'EFFECTIVE' then
      update public.document_version predecessor
         set lifecycle_state = 'SUPERSEDED',
             row_version = predecessor.row_version + 1
       where predecessor.tenant_id = p_tenant_id
         and predecessor.id = v_predecessor_id
       returning predecessor.row_version into v_predecessor_row_version;
    elsif v_predecessor_id is not null
          and v_predecessor_state not in ('SUPERSEDED', 'WITHDRAWN') then
      raise exception using
        errcode = '23514',
        constraint = 'document_version_predecessor_lifecycle',
        message = 'an effective-instant predecessor must be EFFECTIVE or already terminal';
    end if;

    update public.document_version candidate
       set lifecycle_state = 'EFFECTIVE',
           row_version = candidate.row_version + 1
     where candidate.tenant_id = p_tenant_id
       and candidate.id = p_version_id
     returning candidate.lifecycle_state,
               candidate.row_version
          into v_lifecycle_state,
               v_row_version;

    -- Decision Request #84: whichever transaction makes the first version Effective owns
    -- the derived document activation and its event. The conditional update is also the
    -- idempotency mechanism shared with POL-016's immediate path.
    update public.document governed_document
       set lifecycle_status = 'ACTIVE',
           row_version = governed_document.row_version + 1
     where governed_document.tenant_id = p_tenant_id
       and governed_document.id = v_document_id
       and governed_document.lifecycle_status = 'PLANNED';
    v_document_activated := found;
    v_outcome := 'TRANSITIONED';
  end if;

  return query
  select v_outcome,
         p_version_id,
         v_document_id,
         v_variant_id,
         v_configuration_version_id,
         v_previous_state,
         v_lifecycle_state,
         v_effective_from,
         v_effective_until,
         v_row_version,
         v_predecessor_id,
         v_predecessor_state,
         v_predecessor_until,
         v_predecessor_row_version,
         v_document_activated,
         v_policy_gap,
         v_policy_gap_at;
end
$$;

comment on function transition_document_version_effective(uuid, uuid, timestamptz) is
  'INV-EFF-003, INV-EFF-004, INV-EFF-005, INV-EFF-007, INV-EFF-008, INV-DOC-007: tenant-scoped idempotent lifecycle narration from authoritative state';

revoke all on function transition_document_version_effective(uuid, uuid, timestamptz)
  from public;
grant execute on function transition_document_version_effective(uuid, uuid, timestamptz)
  to app_role;
