-- POL-021: enforce the complete structural DocumentVersion lifecycle.

create function assert_version_lifecycle_transition() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_state <> 'DRAFT' then
      raise exception using
        errcode = '23514',
        constraint = 'document_version_lifecycle_transition',
        message = 'a document version must be created as DRAFT';
    end if;
  elsif not (case old.lifecycle_state
    when 'DRAFT' then new.lifecycle_state in ('IN_REVIEW', 'CANCELLED')
    when 'IN_REVIEW' then new.lifecycle_state in (
      'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'
    )
    when 'CHANGES_REQUESTED' then new.lifecycle_state in ('DRAFT', 'CANCELLED')
    when 'APPROVED' then new.lifecycle_state in ('PUBLISHED', 'CANCELLED')
    when 'PUBLISHED' then new.lifecycle_state in ('EFFECTIVE', 'WITHDRAWN')
    when 'EFFECTIVE' then new.lifecycle_state in ('SUPERSEDED', 'WITHDRAWN')
    else false
  end) then
    raise exception using
      errcode = '23514',
      constraint = 'document_version_lifecycle_transition',
      message = format(
        'document version lifecycle transition from %s to %s is not permitted',
        old.lifecycle_state,
        new.lifecycle_state
      );
  end if;
  return new;
end
$$;

comment on function assert_version_lifecycle_transition() is
  'INV-VER-003, INV-EFF-001, INV-EFF-004: only specified version transitions are reachable and terminal history cannot be reopened';

create trigger document_version_lifecycle_transition
  before insert or update of lifecycle_state on document_version
  for each row execute function assert_version_lifecycle_transition();

comment on trigger document_version_lifecycle_transition on document_version is
  'INV-VER-003, INV-EFF-001, INV-EFF-004: enforces the structural version lifecycle without inventing transition authority';
