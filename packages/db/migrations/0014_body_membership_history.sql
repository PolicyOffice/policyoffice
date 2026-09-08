-- POL-020: governance-body membership is historical evidence, so it follows the same
-- close-and-append discipline as organisational membership.
revoke delete, truncate on body_membership from app_role;

-- INV-ORG-002: an open membership may be ended, but neither an ended row nor any of its
-- identifying facts may be rewritten. Preserving those facts also keeps past governance-
-- body composition reconstructible after the body is dissolved (INV-ORG-005).
create function protect_body_membership_history() returns trigger
language plpgsql
as $$
begin
  if not upper_inf(old.validity) then
    raise exception 'ended body memberships are immutable'
      using errcode = '55000';
  end if;

  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.body_id is distinct from old.body_id
     or new.user_id is distinct from old.user_id
     or new.seat_role is distinct from old.seat_role
     or lower(new.validity) is distinct from lower(old.validity)
     or lower_inc(new.validity) is distinct from lower_inc(old.validity)
     or upper_inf(new.validity) then
    raise exception 'an open body membership may only be ended'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

comment on function protect_body_membership_history() is
  'INV-ORG-002, INV-ORG-005: corrections close and append so past body composition remains reconstructible';

create trigger protect_body_membership_history
  before update on body_membership
  for each row execute function protect_body_membership_history();

comment on trigger protect_body_membership_history on body_membership is
  'INV-ORG-002, INV-ORG-005: an ended seat cannot be rewritten or erased from a body history';
