-- POL-041: body resolutions name the institution and cannot predate the submitted text.

create function assert_approval_decision_body_exists()
returns trigger
language plpgsql
as $$
begin
  if new.decided_by_type = 'BODY'
     and not exists (
       select 1
         from governance_body body
        where body.tenant_id = new.tenant_id
          and body.id = new.decided_by_id
     ) then
    raise exception 'body approval decisions must name a governance body in the same tenant'
      using errcode = '23503',
            constraint = 'approval_decision_deciding_body_fk';
  end if;

  return new;
end;
$$;

comment on function assert_approval_decision_body_exists() is
  'INV-TEN-003, INV-APR-021: polymorphic BODY decision identities resolve to a tenant-contained governance body';

create trigger approval_decision_deciding_body_valid
  before insert on approval_decision
  for each row execute function assert_approval_decision_body_exists();

comment on trigger approval_decision_deciding_body_valid on approval_decision is
  'INV-TEN-003, INV-APR-021: BODY decisions cannot name an absent or cross-tenant governance body';

create function assert_resolution_date_after_submission()
returns trigger
language plpgsql
as $$
declare
  submitted_at timestamptz;
begin
  if new.decided_by_type <> 'BODY' or new.resolution_date is null then
    return new;
  end if;

  select revision.submitted_at
    into submitted_at
    from content_revision revision
   where revision.tenant_id = new.tenant_id
     and revision.id = new.content_revision_id;

  if submitted_at is null
     or new.resolution_date < (submitted_at at time zone 'UTC')::date then
    raise exception 'a body resolution cannot predate submission of the revision it approves'
      using errcode = '23514',
            constraint = 'approval_decision_resolution_date_not_before_submission';
  end if;

  return new;
end;
$$;

comment on function assert_resolution_date_after_submission() is
  'INV-APR-022: a body cannot resolve on text before that exact revision was submitted';

create trigger approval_decision_resolution_date_valid
  before insert on approval_decision
  for each row execute function assert_resolution_date_after_submission();

comment on trigger approval_decision_resolution_date_valid on approval_decision is
  'INV-APR-022: optional resolution dates are bounded by the approved revision submission date';
