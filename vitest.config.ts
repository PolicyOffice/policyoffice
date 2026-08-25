import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Architecture and unit tests. Integration tests against a real Postgres arrive with
    // POL-004, which owns the harness and the rule that they connect as app_role.
    include: ["tooling/**/*.test.ts", "packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    environment: "node",
    // INV-TIME-001 stores authoritative instants in UTC. Running tests in UTC would hide
    // every place that assumption is wrong, so the suite runs somewhere else on purpose.
    // Europe/Tallinn is the product's own market and is not UTC in either half of the year.
    env: { TZ: "Europe/Tallinn" },
  },
});
