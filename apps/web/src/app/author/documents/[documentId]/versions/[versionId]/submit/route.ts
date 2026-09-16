import { cookies } from "next/headers";
import { createSubmitContentRevisionHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface SubmitRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request, context: SubmitRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId, versionId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  const handleSubmitContentRevision = createSubmitContentRevisionHandler({
    tenantId: installationTenantId(),
  });
  return handleSubmitContentRevision({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    revisionId: formText(form, "revisionId"),
    expectedVersionRowVersion: Number(formText(form, "expectedVersionRowVersion")),
    expectedRevisionRowVersion: Number(formText(form, "expectedRevisionRowVersion")),
  });
}
