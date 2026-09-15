import { cookies } from "next/headers";
import { createDocumentHandler } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request): Promise<Response> {
  const [cookieStore, form] = await Promise.all([cookies(), request.formData()]);
  const spaceCode = formText(form, "spaceCode");
  const handleCreateDocument = createDocumentHandler({ tenantId: installationTenantId() });
  return handleCreateDocument({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    documentCode: formText(form, "documentCode"),
    canonicalTitle: formText(form, "canonicalTitle"),
    documentTypeCode: formText(form, "documentTypeCode"),
    owningOrgUnitCode: formText(form, "owningOrgUnitCode"),
    spaceCode: spaceCode.trim().length === 0 ? null : spaceCode,
  });
}
