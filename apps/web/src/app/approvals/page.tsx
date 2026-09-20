import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createApprovalInboxHandler } from "@/approval-inbox";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";
import type { ApprovalInboxItem } from "../../../../../packages/domain/src/index";

export const dynamic = "force-dynamic";

interface ApprovalInboxPageProps {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

interface ApprovalInboxPayload {
  readonly items: readonly ApprovalInboxItem[];
}

function formatInstant(value: Date | string): string {
  return `${new Date(value).toISOString()} (UTC)`;
}

function recordedDecision(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return ["APPROVE", "REQUEST_CHANGES", "REJECT"].includes(value) ? value : null;
}

export default async function ApprovalInboxPage({ searchParams }: ApprovalInboxPageProps) {
  const [cookieStore, query] = await Promise.all([cookies(), searchParams]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");

  const response = await createApprovalInboxHandler({ tenantId: installationTenantId() })({
    sessionToken,
  });
  if (!response.ok) redirect("/sign-in");
  const { items } = (await response.json()) as ApprovalInboxPayload;
  const recorded = recordedDecision(query.recorded);

  return (
    <main>
      <p>
        <a href="/">Document register</a>
      </p>
      <h1>Approval inbox</h1>
      {recorded ? <p role="status">Decision recorded: {recorded}</p> : null}
      {items.length === 0 ? (
        <p>No approval work is waiting for you.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.task.id}>
              <a href={`/approvals/${item.task.id}`}>
                <strong>{item.document.code}</strong> {item.document.title} — version{" "}
                {item.version.displayLabel ?? item.version.id}
              </a>
              <br />
              Submitted{" "}
              <time dateTime={new Date(item.revision.submittedAt).toISOString()}>
                {formatInstant(item.revision.submittedAt)}
              </time>
              {item.run.status === "BLOCKED" ? " — Governance exception: run blocked" : ""}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
