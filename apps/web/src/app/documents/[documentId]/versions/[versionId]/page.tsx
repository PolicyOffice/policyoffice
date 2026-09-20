import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createReaderVersionHandler, type ReaderViewPayload } from "@/reader-view";
import { ReaderViewPage } from "@/reader-view-page";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

export default async function ExactDocumentVersionPage({
  params,
}: Readonly<{ params: Promise<Readonly<{ documentId: string; versionId: string }>> }>) {
  const [{ documentId, versionId }, cookieStore] = await Promise.all([params, cookies()]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");
  const response = await createReaderVersionHandler({ tenantId: installationTenantId() })({
    sessionToken,
    documentId,
    versionId,
  });
  if (!response.ok) notFound();
  const payload = (await response.json()) as ReaderViewPayload;
  return <ReaderViewPage {...payload} mode="EXACT" />;
}
