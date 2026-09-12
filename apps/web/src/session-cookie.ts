export const SESSION_COOKIE = Object.freeze({
  name: "policyoffice_session",
  attributes: Object.freeze({
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
  }),
});

const attributeSuffix = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE.name}=${encodeURIComponent(token)}; ${attributeSuffix}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE.name}=; Max-Age=0; ${attributeSuffix}`;
}
