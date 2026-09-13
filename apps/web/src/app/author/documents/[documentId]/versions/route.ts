import { cookies } from "next/headers";
import { createVersionHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface VersionRouteContext {
  readonly params: Promise<Readonly<{ documentId: string }>>;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function POST(request: Request, context: VersionRouteContext): Promise<Response> {
  const [cookieStore, form, { documentId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  const handleCreateVersion = createVersionHandler({ tenantId: installationTenantId() });
  return handleCreateVersion({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentId,
    displayLabel: nullableText(formText(form, "displayLabel")),
    classificationCode: formText(form, "classificationCode"),
    materiality: nullableText(formText(form, "materiality")),
    changeSummary: nullableText(formText(form, "changeSummary")),
  });
}
