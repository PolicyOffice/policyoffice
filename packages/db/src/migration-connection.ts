/**
 * Migrations connect administratively and immediately narrow to migration_role in the
 * runner. A clean database cannot be reached as migration_role because 0001 has not
 * created it yet, and that role must never receive enough privilege to alter itself.
 */
export const DEFAULT_MIGRATION_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/policyoffice";

export function migrationDatabaseUrl(
  env: { MIGRATION_DATABASE_URL?: string } = process.env,
): string {
  return env.MIGRATION_DATABASE_URL ?? DEFAULT_MIGRATION_DATABASE_URL;
}
