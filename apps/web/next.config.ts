import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from "next/constants";
import { installationTenantId } from "./src/installation-tenant";

const config = (phase: string): NextConfig => {
  // Refuse to start a server without the one customer installation it serves. A production
  // build has no customer configuration, so validation belongs to server startup phases.
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_SERVER) {
    installationTenantId();
  }

  return {
    // The domain package is TypeScript source in this workspace; Next compiles it rather
    // than requiring a separate build step in development.
    transpilePackages: ["@policyoffice/db", "@policyoffice/domain"],
    // Argon2 is a native server-only binding. Keep it outside the webpack bundle so Node
    // loads the platform build installed for the running server.
    serverExternalPackages: ["argon2"],
    // Workspace packages use explicit `.js` imports so their TypeScript output runs as
    // native ESM. During a source build, resolve those imports to the corresponding `.ts`
    // modules; emitted JavaScript keeps the production-safe extension unchanged.
    webpack(webpackConfig) {
      webpackConfig.resolve.extensionAlias = {
        ".js": [".js", ".ts", ".tsx"],
        ".mjs": [".mjs", ".mts"],
        ".cjs": [".cjs", ".cts"],
      };
      // The generic Next external-package pass does not see this transitive import through
      // the transpiled workspace package, so keep the native binding external explicitly.
      webpackConfig.externals.push("argon2");
      return webpackConfig;
    },
    // Fail the build on a type error. ADR-0000 trades developer convenience for enforcement
    // strength, and a build that ships with known type errors is the opposite.
    //
    // There is no `eslint` key: Next 16 removed its built-in ESLint integration. Lint is a
    // separate gate in the CI list (`agent-workflow.md`) and runs as its own command, which
    // is where it belongs -- one job, one reason to go red.
    typescript: { ignoreBuildErrors: false },
  };
};

export default config;
