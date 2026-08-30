/**
 * Give the three roles a login and a password. DEVELOPMENT AND CI ONLY.
 *
 * `0001_roles.sql` creates the roles `nologin` with no password, deliberately: a password
 * in a migration is a secret in a public repository, and Neon's control plane rejects weak
 * ones outright, so a fixture password that passes against a CI container would fail
 * against production. Credentials are an environment concern.
 *
 * This is the development and CI half of that. Production sets its own credentials through
 * its platform, and this script must never be run against it -- which is why the passwords
 * below are fixed, obvious and worthless.
 *
 * ALTER, never DROP and recreate: Neon's pooled endpoint caches connections by role OID
 * (verification/README.md finding 6). The habit matters more than this particular script.
 */
import { Client } from "pg";

const ROLES = ["migration_role", "app_role", "retention_role"] as const;

const url =
  process.env.MIGRATION_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/policyoffice";

if (process.env.NODE_ENV === "production") {
  console.error("dev-credentials is for development and CI only. Refusing to run.");
  process.exit(2);
}

const sql = new Client({ connectionString: url });
await sql.connect();
try {
  for (const role of ROLES) {
    // The password equals the role name: unmistakably a development credential, and
    // matching .env.example so a clean clone works with no configuration.
    await sql.query(`alter role ${role} login password '${role}'`);
  }
  console.log(`granted development logins to ${ROLES.join(", ")}`);
} finally {
  await sql.end();
}
