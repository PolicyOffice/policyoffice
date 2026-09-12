import { cookies } from "next/headers";
import { createDocumentRegisterHandler } from "@/document-register";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cookieStore = await cookies();
  const handleDocumentRegister = createDocumentRegisterHandler({
    tenantId: installationTenantId(),
  });
  return handleDocumentRegister({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
  });
}
