import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // ADR-0000: "a lint rule that bans `any` in the domain package".
    //
    // TypeScript's type system cannot express what this domain deserves -- no exhaustive
    // totality checking, no refinement types -- and `any` is always one careless line
    // away. Capabilities and states are modelled as discriminated unions rather than
    // strings (INV-AUTH-016), which is enforcement level 3, and a single `any` dissolves
    // it silently. Elsewhere it is a warning; here it fails the build.
    files: ["packages/domain/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["tooling/**/*.ts", "*.config.ts", "*.config.js"],
    rules: { "no-console": "off" },
  },
);
