import { cookies } from "next/headers";
import { createContentRevisionHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface RevisionRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

export async function POST(request: Request, context: RevisionRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId, versionId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  const content = form.get("content");
  const contentBytes =
    content === null || typeof content === "string"
      ? new Uint8Array()
      : new Uint8Array(await content.arrayBuffer());
  const handleCreateContentRevision = createContentRevisionHandler({
    tenantId: installationTenantId(),
  });
  return handleCreateContentRevision({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    contentBytes,
  });
}
