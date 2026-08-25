/**
 * The superuser trap, closed.
 *
 * `verification/README.md` finding 2: a cross-tenant negative test run as a superuser
 * passes while proving nothing, because a superuser bypasses row-level security whether
 * or not FORCE is set. Finding 5 is the same trap in Neon's default configuration.
 *
 * The obvious mitigation is a convention -- "integration tests must never connect as
 * one". Conventions decay. This makes it a failing test instead: if a test names a
 * tenancy or authorization invariant, and it opened a privileged connection anywhere in
 * its body, the test fails no matter what it asserted.
 *
 * The rule is deliberately narrow. Schema setup legitimately needs `migration_role`, and
 * plenty of tests legitimately need a superuser. What is never legitimate is *proving a
 * tenancy or authorization property* through a connection that is exempt from it.
 */
import { privilegedConnectionInThisTest } from "./db.js";

/** Invariant families whose assertions are void through a privileged connection. */
const RLS_DEPENDENT = /INV-(TEN|AUTH)-\d+/;

/**
 * @param role Injectable so the failure path is testable without opening a real
 *   privileged connection. Defaults to whatever this test actually used.
 */
export function assertNoPrivilegedEscape(
  testName: string | undefined,
  role: string | undefined = privilegedConnectionInThisTest(),
): void {
  if (!testName) return;
  const cited = testName.match(RLS_DEPENDENT);
  if (!cited) return;
  if (!role) return;

  throw new Error(
    [
      `This test cites ${cited[0]} but opened a privileged connection (${role}).`,
      "",
      "Row-level security does not apply to a superuser at all, and `migration_role` owns",
      "the schema. An isolation or authorization assertion made through either connection",
      "passes whether or not the policy it claims to test exists.",
      "",
      "This is not hypothetical: it is exactly how the first run of 02-tenancy.sh passed",
      "while proving nothing (verification/README.md, finding 2).",
      "",
      "Use withAppRole or withTenant for the assertion. If the test genuinely needs",
      "privileged setup, do the setup in a beforeAll and assert through app_role.",
    ].join("\n"),
  );
}
