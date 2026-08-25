-- btree_gist is what makes INV-EFF-002 a level-2 guarantee rather than a level-5 one.
--
-- "For a given Document, variant scope and instant, at most one Version is Effective" is
-- a range-overlap constraint. Expressed as EXCLUDE USING gist it is a rule the application
-- CANNOT break; expressed anywhere else it is a rule the application is checked against
-- afterwards, and a race defeats it. ADR-0000 calls this "the one that ends the
-- discussion" for choosing PostgreSQL at all.
--
-- Created by migration_role. Verified creatable on Neon by a plain non-superuser role
-- (verification/neon.sh); 1.8 there and locally.
create extension if not exists btree_gist;

-- Available without pgcrypto since PostgreSQL 13, and used by every tenant-owned table's
-- default (data-model.md, "Every tenant-owned table").
do $$
begin
  if to_regprocedure('gen_random_uuid()') is null then
    raise exception 'gen_random_uuid() is unavailable; data-model.md assumes it on every tenant-owned table';
  end if;
end $$;
