import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createDraftWorkspaceHandler, type DraftWorkspacePayload } from "@/authoring";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";
import { ContentUploadForm } from "./content-upload-form";

export const dynamic = "force-dynamic";

interface DraftWorkspacePageProps {
  readonly params: Promise<Readonly<{ documentId: string; versionId: string }>>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryText(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveIntegerText(value: string | null): value is string {
  if (value === null) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

export default async function DraftWorkspacePage({
  params,
  searchParams,
}: DraftWorkspacePageProps) {
  const [{ documentId, versionId }, query, cookieStore] = await Promise.all([
    params,
    searchParams,
    cookies(),
  ]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");
  const response = await createDraftWorkspaceHandler({ tenantId: installationTenantId() })({
    sessionToken,
    documentId,
    versionId,
  });
  if (!response.ok) notFound();
  const workspace = (await response.json()) as DraftWorkspacePayload;

  const revisionId = queryText(query.revisionId);
  const revisionRowVersion = queryText(query.revisionRowVersion);
  const versionRowVersion = queryText(query.versionRowVersion);
  const selectedRevision =
    revisionId !== null &&
    UUID.test(revisionId) &&
    positiveIntegerText(revisionRowVersion) &&
    positiveIntegerText(versionRowVersion);
  const canDraft =
    workspace.lifecycleState === "DRAFT" || workspace.lifecycleState === "CHANGES_REQUESTED";
  const canSubmit = workspace.lifecycleState === "DRAFT" && workspace.canSubmit && selectedRevision;
  const submitted = workspace.lifecycleState === "IN_REVIEW";
  const uploadError = queryText(query.error) === "upload";

  return (
    <main>
      <h1>{submitted ? "Version submitted" : "Draft workspace"}</h1>
      {submitted ? (
        <p>The selected revision is frozen and the version is now in review.</p>
      ) : canDraft ? (
        <>
          {uploadError ? <p role="alert">The uploaded file could not be verified.</p> : null}
          <ContentUploadForm
            documentId={documentId}
            submission={
              canSubmit
                ? {
                    revisionId,
                    revisionRowVersion,
                    versionRowVersion,
                  }
                : null
            }
            versionId={versionId}
          />
        </>
      ) : (
        <p>Current version state: {workspace.lifecycleState}.</p>
      )}
    </main>
  );
}
