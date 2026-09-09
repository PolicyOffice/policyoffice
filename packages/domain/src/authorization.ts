/**
 * Authorization contracts only; ADR-0003's evaluator has not landed. Grant creation and
 * revocation entry points must establish this capability before writing an access grant.
 */
export const ACCESS_GRANT_REQUIRED_CAPABILITIES = Object.freeze({
  grant: "document.manage_access",
  revoke: "document.manage_access",
} as const);
