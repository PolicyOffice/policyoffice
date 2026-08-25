import { defineConfig } from "vitest/config";

/**
 * Three projects, because `agent-workflow.md` lists unit tests, integration tests and
 * property-based tests as separate CI gates. One job, one reason to go red.
 *
 * Selected by filename, which keeps the boundary visible in the file tree rather than in
 * configuration:
 *
 *   *.test.ts        unit -- no database, no network
 *   *.int.test.ts    integration -- a real PostgreSQL, connecting as app_role
 *   *.prop.test.ts   property-based -- fast-check
 */
const shared = {
  environment: "node" as const,
  // INV-TIME-001 stores authoritative instants in UTC. Running the suite in UTC hides
  // every place that assumption is wrong. Europe/Tallinn is the product's own market and
  // is offset from UTC in both halves of the year.
  env: { TZ: "Europe/Tallinn" },
  setupFiles: ["packages/testing/src/setup.ts"],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts", "**/*.prop.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: ["**/*.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          // A real database is slower than a mock and that is the point.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Integration tests share one database. Running files in parallel would let
          // two schema-setup hooks race; isolation between *tests* comes from rolled-back
          // transactions, which does not extend to concurrent DDL.
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: "property",
          include: ["**/*.prop.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
