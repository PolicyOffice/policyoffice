/**
 * Liveness only.
 *
 * POL-002 builds the skeleton, and this is the whole of the web surface: enough to prove
 * the application boots, and nothing more.
 *
 * Deliberately absent: any login page, session, cookie, or route that returns data.
 * There is no authorization evaluator yet (INV-AUTH-001), and an unprotected surface --
 * even an empty one -- is the wrong default to establish in the first commit of an
 * application whose entire proposition is provable access control.
 *
 * This endpoint reveals nothing: no version, no tenant, no build metadata, no database
 * state. It answers exactly one question, which is whether the process is up.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
