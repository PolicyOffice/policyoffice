-- The three roles from ADR-0009, established by migration so that privileges are part of
-- the schema and are validated by CI like anything else.
--
-- CREATE ONCE, ALTER THEREAFTER. Never dropped and recreated.
--
-- verification/README.md finding 6: Neon's pooled endpoint caches server connections
-- bound to a role's OID. Dropping a role and recreating it under the same name leaves
-- pooled sessions failing with "invalid role OID" or a spurious permission denied, while
-- the direct endpoint works normally. A migration that recreates a role therefore breaks
-- production through the pooler, presenting as an authorization bug that heals itself
-- when connections cycle -- close to the worst possible shape for a defect here.
--
-- NO PASSWORDS ARE SET HERE, deliberately, for two reasons. A password in a migration is
-- a secret in a public git repository. And Neon's control plane intercepts CREATE ROLE
-- and rejects weak ones with an HTTP 400, so a fixture password that works against the CI
-- container fails against production. Credentials are an environment concern: the local
-- environment sets them in verification/00-roles.sh, and each deployment sets its own.

do $$
declare
  r text;
begin
  foreach r in array array['migration_role', 'app_role', 'retention_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
    -- Applied every run, not only on creation. These attributes are what INV-TEN-001
    -- rests on, and an existing role must not be allowed to drift away from them.
    --
    -- A superuser bypasses row-level security entirely, and FORCE does not change that
    -- (verification/README.md finding 2). BYPASSRLS is the same hole by another name, and
    -- it is how Neon's provisioned role is configured (finding 5).
    execute format('alter role %I nosuperuser nobypassrls nocreatedb', r);
  end loop;
end $$;

-- GRANT ON DATABASE needs an identifier, not an expression, so the database name is
-- interpolated. The chain must apply to whatever database it is pointed at -- the
-- disposable ones the fresh, upgrade and drift checks create, as much as production.
do $$
begin
  execute format('grant connect on database %I to migration_role, app_role, retention_role',
                 current_database());
  execute format('grant create on database %I to migration_role', current_database());
end $$;
