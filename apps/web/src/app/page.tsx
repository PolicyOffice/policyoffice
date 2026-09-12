import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDocumentRegisterHandler } from "@/document-register";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface DocumentRegisterPayload {
  readonly documents: readonly Readonly<{
    id: string;
    documentCode: string;
    canonicalTitle: string;
    lifecycleStatus: string;
  }>[];
}

export default async function DocumentRegisterPage() {
  const cookieStore = await cookies();
  const handleDocumentRegister = createDocumentRegisterHandler({
    tenantId: installationTenantId(),
  });
  const response = await handleDocumentRegister({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
  });
  if (!response.ok) redirect("/sign-in");
  const { documents } = (await response.json()) as DocumentRegisterPayload;

  return (
    <main>
      <h1>Document register</h1>
      <ul>
        {documents.map((document) => (
          <li key={document.id}>
            <strong>{document.documentCode}</strong> {document.canonicalTitle} —{" "}
            {document.lifecycleStatus}
          </li>
        ))}
      </ul>
      <form action="/sign-out" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
