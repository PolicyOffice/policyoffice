import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./session-cookie.js";

describe("the server-side session cookie contract", () => {
  it("matches ADR-0002 and remains host-scoped", () => {
    expect(SESSION_COOKIE).toEqual({
      name: "policyoffice_session",
      attributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    });
    expect(SESSION_COOKIE.attributes).not.toHaveProperty("domain");
  });
});
