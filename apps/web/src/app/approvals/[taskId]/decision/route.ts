import { cookies } from "next/headers";
import { createApprovalDecisionHandler } from "@/approval-inbox";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";

export const dynamic = "force-dynamic";

interface ApprovalDecisionRouteContext {
  readonly params: Promise<Readonly<{ taskId: string }>>;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function uuidList(value: string): readonly string[] | null {
  const members = value
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
  return members.length === 0 ? null : members;
}

export async function POST(
  request: Request,
  context: ApprovalDecisionRouteContext,
): Promise<Response> {
  const [cookieStore, form, { taskId }] = await Promise.all([
    cookies(),
    request.formData(),
    context.params,
  ]);
  return createApprovalDecisionHandler({ tenantId: installationTenantId() })({
    sessionToken: cookieStore.get(SESSION_COOKIE.name)?.value,
    taskId,
    decision: formText(form, "decision"),
    reasonCode: nullableText(formText(form, "reasonCode")),
    resolutionReference: nullableText(formText(form, "resolutionReference")),
    resolutionDate: nullableText(formText(form, "resolutionDate")),
    minutesAttachmentId: nullableText(formText(form, "minutesAttachmentId")),
    attendingMembers: uuidList(formText(form, "attendingMembers")),
  });
}
