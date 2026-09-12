import { defineConfig, devices } from "@playwright/test";

const TEST_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

export default defineConfig({
  testDir: "./playwright",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  globalSetup: "./playwright/global-setup.ts",
  outputDir: "test-results",
  webServer: {
    command: "pnpm --filter @policyoffice/web dev",
    url: "http://localhost:3000/sign-in",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://app_role:app_role@localhost:5432/policyoffice",
      POLICYOFFICE_TENANT_ID: TEST_TENANT_ID,
    },
  },
});
