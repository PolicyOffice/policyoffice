import { cookies } from "next/headers";
import { createPublishDocumentVersionFormHandler } from "@/publication";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface PublicationRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request, context: PublicationRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId, versionId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  return createPublishDocumentVersionFormHandler({ tenantId: installationTenantId() })({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    expectedRowVersion: Number(formText(form, "expectedRowVersion")),
    effectiveMode: formText(form, "effectiveMode"),
    effectiveFrom: formText(form, "effectiveFrom"),
  });
}
