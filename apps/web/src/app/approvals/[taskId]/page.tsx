import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createApprovalCandidateHandler, type ApprovalCandidatePayload } from "@/approval-inbox";
import { installationTenantId } from "@/installation-tenant";
import { SESSION_COOKIE } from "@/session-cookie";
import type { ApprovalInboxApplicabilityRule } from "../../../../../../packages/domain/src/index";

export const dynamic = "force-dynamic";

interface ApprovalCandidatePageProps {
  readonly params: Promise<Readonly<{ taskId: string }>>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

function formatInstant(value: Date | string): string {
  return `${new Date(value).toISOString()} (UTC)`;
}

function completionRule(rule: string, threshold: number | null): string {
  return rule === "AT_LEAST_N" && threshold !== null ? `${rule} (${threshold})` : rule;
}

function applicabilityTargets(rule: ApprovalInboxApplicabilityRule): string {
  const groups = [
    ["Legal entities", rule.legalEntities],
    ["Organisational units", rule.orgUnits],
    ["Jurisdictions", rule.jurisdictions],
    ["Groups", rule.groups],
    ["People", rule.users],
  ] as const;
  const targets = groups
    .filter(([, targets]) => targets.length > 0)
    .map(([label, targets]) => `${label}: ${targets.map(({ name }) => name).join(", ")}`)
    .join("; ");
  return targets || "Tenant-wide";
}

export default async function ApprovalCandidatePage({
  params,
  searchParams,
}: ApprovalCandidatePageProps) {
  const [{ taskId }, query, cookieStore] = await Promise.all([params, searchParams, cookies()]);
  const sessionToken = cookieStore.get(SESSION_COOKIE.name)?.value;
  if (!sessionToken) redirect("/sign-in");

  const response = await createApprovalCandidateHandler({ tenantId: installationTenantId() })({
    sessionToken,
    taskId,
  });
  if (!response.ok) notFound();
  const { item, canDecide } = (await response.json()) as ApprovalCandidatePayload;
  const actionable =
    canDecide &&
    item.task.status === "PENDING" &&
    item.stage.status === "IN_PROGRESS" &&
    item.run.status === "RUNNING";
  const invalid = query.error === "invalid";

  return (
    <main>
      <p>
        <a href="/approvals">Approval inbox</a>
      </p>
      <h1>
        {item.document.code} {item.document.title}
      </h1>

      <section aria-labelledby="candidate-details">
        <h2 id="candidate-details">Submitted candidate</h2>
        <dl>
          <dt>Document identifier</dt>
          <dd>{item.document.id}</dd>
          <dt>Version</dt>
          <dd>{item.version.displayLabel ?? item.version.id}</dd>
          <dt>Version identifier</dt>
          <dd>{item.version.id}</dd>
          <dt>Submitted</dt>
          <dd>
            <time dateTime={new Date(item.revision.submittedAt).toISOString()}>
              {formatInstant(item.revision.submittedAt)}
            </time>
          </dd>
          <dt>Materiality</dt>
          <dd>{item.version.materiality ?? "Not classified"}</dd>
          <dt>Owning scope</dt>
          <dd>
            {item.scope.orgUnitName} ({item.scope.orgUnitCode})
          </dd>
          <dt>Frozen applicability scope</dt>
          <dd>
            {item.scope.applicabilityRules.length === 0 ? (
              "No frozen applicability rules recorded"
            ) : (
              <ul>
                {item.scope.applicabilityRules.map((rule) => (
                  <li key={rule.id}>
                    {rule.effect} · {rule.inheritanceMode} · {applicabilityTargets(rule)} · valid{" "}
                    <time dateTime={new Date(rule.validFrom).toISOString()}>
                      {formatInstant(rule.validFrom)}
                    </time>
                    {rule.validUntil === null ? (
                      " onward"
                    ) : (
                      <>
                        {" "}
                        until{" "}
                        <time dateTime={new Date(rule.validUntil).toISOString()}>
                          {formatInstant(rule.validUntil)}
                        </time>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt>Stage</dt>
          <dd>{item.stage.order}</dd>
          <dt>Completion rule</dt>
          <dd>{completionRule(item.stage.completionRule, item.stage.threshold)}</dd>
          <dt>Decision authority</dt>
          <dd>
            {item.task.participant.name} ({item.task.participant.type})
          </dd>
          <dt>Exact content revision</dt>
          <dd>{item.revision.id}</dd>
          <dt>Content digest</dt>
          <dd>{item.revision.digest}</dd>
          <dt>Change summary</dt>
          <dd>{item.version.changeSummary ?? "No change summary supplied"}</dd>
        </dl>
      </section>

      <section aria-labelledby="prior-decisions">
        <h2 id="prior-decisions">Prior decisions on this candidate</h2>
        {item.priorDecisions.length === 0 ? (
          <p>No prior decisions.</p>
        ) : (
          <ol>
            {item.priorDecisions.map((decision) => (
              <li key={decision.id}>
                <strong>{decision.decision}</strong> —{" "}
                {decision.decidedBy.type === "BODY" ? (
                  <>
                    Deciding body: {decision.decidedBy.name}; recorded by {decision.recordedBy.name}
                  </>
                ) : (
                  <>Decided by {decision.decidedBy.name}</>
                )}{" "}
                at{" "}
                <time dateTime={new Date(decision.recordedAt).toISOString()}>
                  {formatInstant(decision.recordedAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>

      {item.run.status === "BLOCKED" ? (
        <section aria-labelledby="governance-exception">
          <h2 id="governance-exception">Governance exception</h2>
          <p>This approval run is blocked and cannot accept a decision.</p>
        </section>
      ) : actionable ? (
        <section aria-labelledby="decision-controls">
          <h2 id="decision-controls">
            {item.task.participant.type === "GOVERNANCE_BODY"
              ? `Record ${item.task.participant.name} resolution`
              : "Record your decision"}
          </h2>
          {invalid ? <p role="alert">The decision evidence was invalid.</p> : null}
          <form action={`/approvals/${item.task.id}/decision`} method="post">
            <label htmlFor="reasonCode">Reason code (optional)</label>
            <input id="reasonCode" name="reasonCode" type="text" />
            {item.task.participant.type === "GOVERNANCE_BODY" ? (
              <>
                <label htmlFor="resolutionReference">Resolution reference (optional)</label>
                <input id="resolutionReference" name="resolutionReference" type="text" />
                <label htmlFor="resolutionDate">Resolution date (optional)</label>
                <input id="resolutionDate" name="resolutionDate" type="date" />
                <label htmlFor="minutesAttachmentId">
                  Minutes attachment identifier (optional)
                </label>
                <input id="minutesAttachmentId" name="minutesAttachmentId" type="text" />
                <label htmlFor="attendingMembers">
                  Attending member identifiers, comma separated (optional)
                </label>
                <input id="attendingMembers" name="attendingMembers" type="text" />
                <p>
                  The named governance body is the deciding authority. The signed-in person records
                  its resolution.
                </p>
              </>
            ) : null}
            <button name="decision" type="submit" value="APPROVE">
              Approve
            </button>
            <button name="decision" type="submit" value="REQUEST_CHANGES">
              Request changes
            </button>
            <button name="decision" type="submit" value="REJECT">
              Reject
            </button>
          </form>
        </section>
      ) : (
        <section aria-labelledby="decision-unavailable">
          <h2 id="decision-unavailable">Decision unavailable</h2>
          <p>You do not currently hold the authority required to record this decision.</p>
        </section>
      )}
    </main>
  );
}
