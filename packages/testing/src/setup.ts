/**
 * Vitest setup, applied to every test file. Registered in `vitest.config.ts`.
 *
 * Two things happen here, and both exist so that a test cannot quietly be less rigorous
 * than it looks.
 */
import { afterEach, beforeEach, expect } from "vitest";
import { assertNoPrivilegedEscape, resetPrivilegeTracking } from "./index.js";

beforeEach(() => {
  resetPrivilegeTracking();
});

afterEach(() => {
  // Fails the test if it cited a tenancy or authorization invariant while holding a
  // connection exempt from row-level security. See guard.ts for why this is not left to
  // a convention.
  assertNoPrivilegedEscape(expect.getState().currentTestName);
});
