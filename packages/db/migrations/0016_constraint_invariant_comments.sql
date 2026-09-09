-- POL-022: close the historical constraint-comment gap without changing any constraint.
-- Applied migrations are immutable under ADR-0009, so these comments are forward-only.

set local role migration_role;

comment on constraint tenant_pkey on tenant is
  'INV-TEN-003: the tenant root identity anchors every tenant-owned row';

comment on constraint app_user_id_unique on app_user is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint user_credential_id_unique on user_credential is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint user_session_id_unique on user_session is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint user_group_id_unique on user_group is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';
comment on constraint group_membership_id_unique on group_membership is
  'INV-TEN-003: globally addressable IDs support tenant-contained references';

reset role;
