import type { NextConfig } from "next";

const config: NextConfig = {
  // The domain package is TypeScript source in this workspace; Next compiles it rather
  // than requiring a separate build step in development.
  transpilePackages: ["@policyoffice/domain"],
  // Fail the build on a type error. ADR-0000 trades developer convenience for enforcement
  // strength, and a build that ships with known type errors is the opposite.
  //
  // There is no `eslint` key: Next 16 removed its built-in ESLint integration. Lint is a
  // separate gate in the CI list (`agent-workflow.md`) and runs as its own command, which
  // is where it belongs -- one job, one reason to go red.
  typescript: { ignoreBuildErrors: false },
};

export default config;
