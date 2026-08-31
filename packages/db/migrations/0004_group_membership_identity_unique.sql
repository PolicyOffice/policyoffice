-- data-model.md § Tenancy and identity requires one membership row for an exact
-- (tenant, group, user, validity) tuple. 0003 omitted that constraint. It is already
-- applied in development, so the correction is forward-only rather than an edit that
-- would trip ADR-0009's checksum guard.

set local role migration_role;

alter table group_membership
  add constraint group_membership_identity_validity_unique
  unique (tenant_id, group_id, user_id, validity);

comment on constraint group_membership_identity_validity_unique on group_membership is
  'One authoritative membership row per tenant, group, user and exact validity interval';

reset role;
