import { cookies } from "next/headers";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";
import { createSignOutHandler } from "@/sign-out";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const handleSignOut = createSignOutHandler({ tenantId: installationTenantId() });
  return handleSignOut({ sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value });
}
