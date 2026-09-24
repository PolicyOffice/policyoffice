import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createPublicationFormHandler, type PublicationFormPayload } from "@/publication";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface PublicationPageProps {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
}

export default async function PublicationPage({ params }: PublicationPageProps) {
  const [{ documentId, versionId }, cookieStore] = await Promise.all([params, cookies()]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");
  const response = await createPublicationFormHandler({ tenantId: installationTenantId() })({
    sessionToken,
    documentId,
    versionId,
  });
  if (!response.ok) notFound();
  const publication = (await response.json()) as PublicationFormPayload;

  return (
    <main>
      <h1>Publish version</h1>
      <p>
        <strong>{publication.documentCode}</strong> {publication.versionTitle}
        {publication.displayLabel ? ` — ${publication.displayLabel}` : ""}
      </p>
      <form action={`/author/documents/${documentId}/versions/${versionId}/publish`} method="post">
        <input
          name="expectedRowVersion"
          type="hidden"
          value={String(publication.expectedRowVersion)}
        />
        <fieldset>
          <legend>Effective instant</legend>
          <p>
            <label>
              <input defaultChecked name="effectiveMode" type="radio" value="now" />
              Immediately
            </label>
          </p>
          <p>
            <label>
              <input name="effectiveMode" type="radio" value="scheduled" />
              Schedule for a future instant
            </label>
          </p>
          <p>
            <label htmlFor="effectiveFrom">Scheduled instant (UTC)</label>
            <br />
            <input id="effectiveFrom" name="effectiveFrom" type="datetime-local" />
          </p>
        </fieldset>
        <button type="submit">Publish version</button>
      </form>
    </main>
  );
}
