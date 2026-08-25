import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./.drizzle",
  // Migrations are hand-written SQL in ./migrations and applied by ./src/runner.ts.
  // drizzle-kit is used only to render this schema for the drift check -- never to
  // generate or apply a migration. See ADR-0000 and ADR-0009.
});
