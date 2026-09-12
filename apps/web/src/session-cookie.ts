export const SESSION_COOKIE = Object.freeze({
  name: "policyoffice_session",
  attributes: Object.freeze({
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
  }),
});
