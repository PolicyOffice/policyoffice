import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDocumentRegisterHandler } from "@/document-register";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface DocumentRegisterPayload {
  readonly canCreate: boolean;
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
  const { canCreate, documents } = (await response.json()) as DocumentRegisterPayload;

  return (
    <main>
      <h1>Document register</h1>
      {canCreate ? (
        <p>
          <a href="/author/documents/new">Create document</a>
        </p>
      ) : null}
      <p>
        <a href="/approvals">Approval inbox</a>
      </p>
      <ul>
        {documents.map((document) => (
          <li key={document.id}>
            <a href={`/documents/${document.id}`}>
              <strong>{document.documentCode}</strong> {document.canonicalTitle}
            </a>{" "}
            — {document.lifecycleStatus}
          </li>
        ))}
      </ul>
      <form action="/sign-out" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
