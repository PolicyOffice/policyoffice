import { createSignInHandler } from "@/sign-in";
import { installationTenantId } from "@/installation-tenant";

export const dynamic = "force-dynamic";

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const handleSignIn = createSignInHandler({ tenantId: installationTenantId() });
  return handleSignIn({
    contactEmail: formText(form, "contactEmail"),
    password: formText(form, "password"),
    // Store a coarse class, never the raw User-Agent string.
    userAgentClass: "browser",
  });
}
