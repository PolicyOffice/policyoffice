interface DocumentAuthorPageProps {
  readonly params: Promise<Readonly<{ documentId: string }>>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export default async function DocumentAuthorPage({
  params,
  searchParams,
}: DocumentAuthorPageProps) {
  const [{ documentId }, query] = await Promise.all([params, searchParams]);

  return (
    <main>
      <h1>Document created</h1>
      <p>Start the first governed version for this document.</p>
      <form action={`/author/documents/${documentId}/versions`} method="post">
        <label htmlFor="displayLabel">Display label</label>
        <input id="displayLabel" name="displayLabel" />
        <label htmlFor="classificationCode">Information classification code</label>
        <input defaultValue="INTERNAL" id="classificationCode" name="classificationCode" required />
        <label htmlFor="materiality">Materiality</label>
        <select defaultValue="MATERIAL" id="materiality" name="materiality">
          <option value="">Not set</option>
          <option value="EDITORIAL">Editorial</option>
          <option value="NON_MATERIAL">Non-material</option>
          <option value="MATERIAL">Material</option>
          <option value="EMERGENCY">Emergency</option>
        </select>
        <label htmlFor="changeSummary">Change summary</label>
        <textarea id="changeSummary" name="changeSummary" />
        <button type="submit">Start version</button>
      </form>
      <p aria-live="polite" role="alert">
        {query.error === "invalid" ? "Check the version details and try again." : ""}
      </p>
    </main>
  );
}
