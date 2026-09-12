import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, clearSessionCookie, serializeSessionCookie } from "./session-cookie.js";

describe("the server-side session cookie contract", () => {
  it("matches ADR-0002 and remains host-scoped", () => {
    expect(SESSION_COOKIE).toEqual({
      name: "policyoffice_session",
      attributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    });
    expect(SESSION_COOKIE.attributes).not.toHaveProperty("domain");
  });

  it("INV-AUTH-004: serializes only the opaque token with all required attributes", () => {
    expect(serializeSessionCookie("opaque-token")).toBe(
      "policyoffice_session=opaque-token; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(serializeSessionCookie("opaque-token")).not.toContain("Domain=");
  });

  it("clears the same host-scoped cookie", () => {
    expect(clearSessionCookie()).toBe(
      "policyoffice_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
