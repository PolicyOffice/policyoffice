import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDocumentRegisterHandler } from "@/document-register";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface DocumentRegisterPayload {
  readonly canCreate: boolean;
  readonly publicationCandidates: readonly Readonly<{
    documentId: string;
    versionId: string;
    documentCode: string;
    versionTitle: string;
    displayLabel: string | null;
  }>[];
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
  const { canCreate, documents, publicationCandidates } =
    (await response.json()) as DocumentRegisterPayload;

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
      {publicationCandidates.length > 0 ? (
        <section aria-labelledby="publication-heading">
          <h2 id="publication-heading">Ready to publish</h2>
          <ul>
            {publicationCandidates.map((candidate) => (
              <li key={candidate.versionId}>
                <a
                  href={`/author/documents/${candidate.documentId}/versions/${candidate.versionId}/publication`}
                >
                  {candidate.documentCode} {candidate.versionTitle}
                  {candidate.displayLabel ? ` — ${candidate.displayLabel}` : ""}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
