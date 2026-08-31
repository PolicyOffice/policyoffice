import type { QueryResultRow } from "pg";

export interface TenantTableSecurityRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_policy: boolean;
}

export interface TenantTableSecurityProblem {
  table: string;
  missing: ("RLS enabled" | "RLS forced" | "tenant policy")[];
}

/**
 * Discovers tenant-owned tables from the schema itself. This must never become a list:
 * the first new table omitted from a hard-coded list would quietly weaken every isolation
 * assertion added after it.
 */
export const TENANT_TABLE_SECURITY_QUERY = `
  select n.nspname as schema_name,
         c.relname as table_name,
         c.relrowsecurity as rls_enabled,
         c.relforcerowsecurity as rls_forced,
         exists (
           select 1 from pg_policy p
            where p.polrelid = c.oid and p.polname = 'tenant_isolation'
         ) as has_tenant_policy
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname = 'public'
     and exists (
       select 1 from pg_attribute a
        where a.attrelid = c.oid
          and a.attname = 'tenant_id'
          and a.attnum > 0
          and not a.attisdropped
     )
   order by n.nspname, c.relname
`;

export function tenantTableSecurityProblems(
  rows: readonly TenantTableSecurityRow[],
): TenantTableSecurityProblem[] {
  return rows.flatMap((row) => {
    const missing: TenantTableSecurityProblem["missing"] = [];
    if (!row.rls_enabled) missing.push("RLS enabled");
    if (!row.rls_forced) missing.push("RLS forced");
    if (!row.has_tenant_policy) missing.push("tenant policy");
    return missing.length ? [{ table: `${row.schema_name}.${row.table_name}`, missing }] : [];
  });
}
