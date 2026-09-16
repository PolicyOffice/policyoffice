import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createDocumentFormHandler } from "@/document-register";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

interface NewDocumentPageProps {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export default async function NewDocumentPage({ searchParams }: NewDocumentPageProps) {
  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");
  const response = await createDocumentFormHandler({
    tenantId: installationTenantId(),
  })({ sessionToken });
  if (!response.ok) notFound();

  return (
    <main>
      <h1>Create document</h1>
      <form action="/author/documents" method="post">
        <label htmlFor="documentCode">Document code</label>
        <input id="documentCode" name="documentCode" required />
        <label htmlFor="canonicalTitle">Title</label>
        <input id="canonicalTitle" name="canonicalTitle" required />
        <label htmlFor="documentTypeCode">Document type code</label>
        <input defaultValue="POLICY" id="documentTypeCode" name="documentTypeCode" required />
        <label htmlFor="owningOrgUnitCode">Owning organisation unit code</label>
        <input
          defaultValue="HEAD_OFFICE"
          id="owningOrgUnitCode"
          name="owningOrgUnitCode"
          required
        />
        <label htmlFor="spaceCode">Space code</label>
        <input defaultValue="POLICIES" id="spaceCode" name="spaceCode" />
        <button type="submit">Create document</button>
      </form>
      <p aria-live="polite" role="alert">
        {params.error === "invalid" ? "Check the document details and try again." : ""}
      </p>
      <p>
        <a href="/">Back to the document register</a>
      </p>
    </main>
  );
}
