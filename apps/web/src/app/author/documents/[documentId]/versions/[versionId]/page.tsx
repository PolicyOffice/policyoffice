interface DraftWorkspacePageProps {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

function queryText(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export default async function DraftWorkspacePage({
  params,
  searchParams,
}: DraftWorkspacePageProps) {
  const [{ documentId, versionId }, query] = await Promise.all([params, searchParams]);
  const revisionId = queryText(query.revisionId);
  const revisionRowVersion = queryText(query.revisionRowVersion);
  const versionRowVersion = queryText(query.versionRowVersion);
  const canSubmit = revisionId && revisionRowVersion && versionRowVersion;
  const submitted = query.submitted === "1";

  return (
    <main>
      <h1>{submitted ? "Version submitted" : "Draft workspace"}</h1>
      {submitted ? (
        <p>The selected revision is frozen and the version is now in review.</p>
      ) : (
        <>
          <form
            action={`/author/documents/${documentId}/versions/${versionId}/revisions`}
            encType="multipart/form-data"
            method="post"
          >
            <label htmlFor="content">Candidate policy file</label>
            <input id="content" name="content" required type="file" />
            <button type="submit">Save draft</button>
          </form>
          {canSubmit ? (
            <form
              action={`/author/documents/${documentId}/versions/${versionId}/submit`}
              method="post"
            >
              <input name="revisionId" type="hidden" value={revisionId} />
              <input name="expectedRevisionRowVersion" type="hidden" value={revisionRowVersion} />
              <input name="expectedVersionRowVersion" type="hidden" value={versionRowVersion} />
              <button type="submit">Submit for review</button>
            </form>
          ) : null}
        </>
      )}
      <p aria-live="polite" role="status">
        {query.saved ? `Draft revision ${query.saved} saved.` : ""}
      </p>
      <p aria-live="polite" role="alert">
        {query.error === "invalid" ? "Choose a non-empty candidate file and try again." : ""}
      </p>
    </main>
  );
}
