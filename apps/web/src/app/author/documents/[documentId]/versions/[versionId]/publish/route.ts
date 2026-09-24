import { cookies } from "next/headers";
import { createPublishDocumentVersionHandler } from "@/publication";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface PublicationRouteContext {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

const UTC_LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function utcInstant(value: string): Date {
  return new Date(UTC_LOCAL_MINUTE.test(value) ? `${value}:00.000Z` : Number.NaN);
}

function effectiveFrom(form: FormData): Date | null {
  const mode = formText(form, "effectiveMode");
  if (mode === "now") return null;
  if (mode === "scheduled") return utcInstant(formText(form, "effectiveFrom"));
  return new Date(Number.NaN);
}

export async function POST(request: Request, context: PublicationRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId, versionId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  return createPublishDocumentVersionHandler({ tenantId: installationTenantId() })({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    versionId,
    expectedRowVersion: Number(formText(form, "expectedRowVersion")),
    effectiveFrom: effectiveFrom(form),
  });
}
