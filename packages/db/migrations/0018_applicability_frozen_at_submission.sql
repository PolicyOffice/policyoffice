-- POL-037: freeze applicability scope while approvers review a candidate.

-- A rule may cite a candidate while scope is editable in DRAFT or CHANGES_REQUESTED.
-- Submission itself is the sole IN_REVIEW provenance write: the lifecycle trigger stamps
-- every still-null draft rule after the version has already entered IN_REVIEW.
create or replace function assert_applicability_rule_authority() returns trigger
language plpgsql
as $$
declare
  authority_state version_lifecycle;
  authority_variant_id uuid;
  is_submission_capture boolean := false;
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

  if tg_op = 'UPDATE' then
    is_submission_capture :=
      old.authorised_by_version_id is null
      and new.authorised_by_version_id is not null
      and new.tenant_id is not distinct from old.tenant_id
      and new.id is not distinct from old.id
      and new.created_at is not distinct from old.created_at
      and new.document_variant_id is not distinct from old.document_variant_id
      and new.effect is not distinct from old.effect
      and new.legal_entity_ids is not distinct from old.legal_entity_ids
      and new.org_unit_ids is not distinct from old.org_unit_ids
      and new.jurisdiction_ids is not distinct from old.jurisdiction_ids
      and new.group_ids is not distinct from old.group_ids
      and new.user_ids is not distinct from old.user_ids
      and new.inheritance_mode is not distinct from old.inheritance_mode
      and new.validity is not distinct from old.validity
      and authority_state = 'IN_REVIEW';
  end if;

  if (
    tg_op = 'INSERT'
    or new.authorised_by_version_id is distinct from old.authorised_by_version_id
    or new.document_variant_id is distinct from old.document_variant_id
  ) then
    if authority_state = 'IN_REVIEW' and not is_submission_capture then
      raise exception 'an in-review version cannot authorise a new applicability fact'
        using errcode = '23514', constraint = 'applicability_rule_authority_frozen_in_review';
    end if;

    if authority_state not in ('DRAFT', 'CHANGES_REQUESTED', 'IN_REVIEW') then
      raise exception 'a released or terminal version cannot authorise a new applicability fact'
        using errcode = '23514', constraint = 'applicability_rule_authority_mutable';
    end if;
  end if;

  return new;
end;
$$;

comment on function assert_applicability_rule_authority() is
  'INV-VER-002, INV-VER-007: submission captures same-variant rule provenance, then refuses new facts until changes are requested';

comment on trigger enforce_applicability_rule_authority on applicability_rule is
  'INV-TEN-003, INV-VER-002, INV-VER-007: provenance is tenant-contained, variant-matched and frozen during review and after approval';

-- Ended rules are historical facts. IN_REVIEW freezes the complete rule as the scope
-- snapshot approvers see. After approval, retain the established close-and-append rule:
-- an open interval may acquire its upper bound, but no governed fact may be rewritten.
create or replace function protect_applicability_rule_history() returns trigger
language plpgsql
as $$
declare
  authority_state version_lifecycle;
  is_submission_capture boolean := false;
begin
  if coalesce(old.authorised_by_version_id, new.authorised_by_version_id) is not null then
    select lifecycle_state
      into authority_state
      from document_version
     where tenant_id = old.tenant_id
       and id = coalesce(old.authorised_by_version_id, new.authorised_by_version_id)
     for share;
  end if;

  is_submission_capture :=
    old.authorised_by_version_id is null
    and new.authorised_by_version_id is not null
    and authority_state = 'IN_REVIEW'
    and new.tenant_id is not distinct from old.tenant_id
    and new.id is not distinct from old.id
    and new.created_at is not distinct from old.created_at
    and new.document_variant_id is not distinct from old.document_variant_id
    and new.effect is not distinct from old.effect
    and new.legal_entity_ids is not distinct from old.legal_entity_ids
    and new.org_unit_ids is not distinct from old.org_unit_ids
    and new.jurisdiction_ids is not distinct from old.jurisdiction_ids
    and new.group_ids is not distinct from old.group_ids
    and new.user_ids is not distinct from old.user_ids
    and new.inheritance_mode is not distinct from old.inheritance_mode
    and new.validity is not distinct from old.validity;

  if is_submission_capture then
    return new;
  end if;

  if not upper_inf(old.validity) then
    raise exception 'ended applicability rules are immutable'
      using errcode = '55000', constraint = 'applicability_rule_history_immutable';
  end if;

  if authority_state = 'IN_REVIEW' then
    raise exception 'an in-review applicability rule is immutable until changes are requested'
      using errcode = '55000', constraint = 'applicability_rule_in_review_immutable';
  end if;

  if authority_state in (
    'APPROVED', 'PUBLISHED', 'EFFECTIVE', 'SUPERSEDED',
    'WITHDRAWN', 'REJECTED', 'CANCELLED'
  ) and (
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
  'INV-VER-002, INV-VER-007, INV-TIME-005: scope is immutable during review; approved applicability is corrected only by closing and appending half-open facts';

comment on trigger protect_applicability_rule_history on applicability_rule is
  'INV-VER-002, INV-VER-007: in-review rules are frozen; ended rules are immutable; approved rules may only be closed';
