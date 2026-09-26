import { cookies } from "next/headers";
import { createContentRevisionHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { controlledFileStorage } from "@/object-storage";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface FinalizeRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string; revisionId: string }>>;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request, context: FinalizeRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId, versionId, revisionId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  return createContentRevisionHandler({
    tenantId: installationTenantId(),
    storage: controlledFileStorage(),
  })({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    revisionId,
    slotId: formText(form, "slotId"),
    claimedDigest: formText(form, "claimedDigest"),
    claimedByteSize: Number(formText(form, "claimedByteSize")),
    expiresAt: formText(form, "expiresAt"),
  });
}
