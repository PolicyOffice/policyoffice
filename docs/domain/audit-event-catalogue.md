# Audit Event Catalogue

The evidence ledger. Every governance-relevant transition in the product emits exactly one
canonical event, and the sequence of those events is what an evidence pack reconstructs.

> **INV-AUD-001 — Every governance-relevant transition emits exactly one canonical audit
> event.**

Missing events make evidence incomplete. Duplicate events make it untrustworthy. Both
failures are worse than they sound, because neither is visible until someone tries to use
the record to prove something.

## What belongs here, and what does not

> **INV-AUD-007 — Business governance events and low-level security or observability logs
> remain separately modelled.**

| Belongs in the ledger | Belongs in operational logging |
|---|---|
| A version was approved, published, made effective | An HTTP request was served in 40 ms |
| A grant was created, expired, revoked | A connection pool was exhausted |
| A campaign launched; a response was recorded | A template failed to render |
| A configuration control was weakened | A background worker restarted |
| An evidence pack was generated and downloaded | A cache was invalidated |

The ledger is not a request log. Putting every HTTP call in it makes the governance record
unreadable, multiplies personal-data exposure, and quietly converts a compliance product
into an employee monitoring system.

## Naming

`family.action`, lowercase, dotted, past tense — `document.created`, `version.approved`,
`attestation.acknowledged`.

The family is the aggregate the event is about, not the screen it came from. Event names
are permanent: they appear in customer filters, exported evidence and integrations, and
renaming one silently reinterprets historical records.

## The envelope

Every event carries the same envelope. Family-specific attributes go in a narrow, declared
set of fields — never a free-form payload.

| Field | Required | Purpose |
|---|:---:|---|
| `event_id` | yes | Immutable identity, usable for idempotent consumption |
| `tenant_id` | yes | Isolation. Nothing crosses it |
| `event_type` | yes | From this catalogue |
| `event_schema_version` | yes | Which version of this event's contract produced it |
| `occurred_at` | yes | The authoritative instant, UTC |
| `recorded_at` | yes | When the ledger received it. Differs from `occurred_at` for backdated governance facts such as a resolution date |
| `sequence` | yes | Monotonic within the tenant. Gives a stable total order |
| `actor_type`, `actor_id` | yes | `USER`, `BODY`, `API_CLIENT`, `SYSTEM`. An integration or AI agent acting for a person is an `API_CLIENT`, not a new actor kind — what distinguishes it is the pair below, not a label |
| `originating_actor_id` | where applicable | The delegating or impersonating principal. For a delegated machine call, the human on whose authority it acted (INV-AUD-006, INV-AUTH-018) |
| `elevation_session_id` | where applicable | The break-glass session this action was taken inside |
| `subject_type`, `subject_id` | yes | What the event is about |
| `document_id`, `document_variant_id`, `document_version_id` | where applicable | Governance coordinates, so evidence queries need no joins through five tables |
| `action`, `outcome` | yes | `SUCCESS` or `FAILURE`. Failed governed actions are recorded where evidentially relevant |
| `reason_code`, `comment_ref` | where required | Structured reason, and a reference to free text held elsewhere |
| `request_id`, `correlation_id` | yes | Correlate the events of one operation, and one user journey |
| `source_channel` | yes | `WEB`, `API`, `JOB`, `IMPORT` |
| `safe_before`, `safe_after` | where applicable | Minimal before/after metadata for configuration and metadata changes |
| `configuration_version_id` | yes | The configuration in force when it happened (INV-CFG-003) |
| `integrity_metadata` | later | Reserved for hash chaining or signed checkpoints |

```json
{
  "eventId": "…",
  "eventType": "version.approved",
  "eventSchemaVersion": 1,
  "tenantId": "…",
  "occurredAt": "2027-01-15T09:42:17.231Z",
  "recordedAt": "2027-01-15T09:42:17.245Z",
  "sequence": 918273,
  "actor": { "type": "BODY", "id": "…" },
  "originatingActorId": null,
  "recordedByUserId": "…",
  "subject": { "type": "DOCUMENT_VERSION", "id": "…" },
  "documentId": "…",
  "documentVariantId": "…",
  "documentVersionId": "…",
  "action": "APPROVE",
  "outcome": "SUCCESS",
  "reasonCode": null,
  "contentDigest": "sha-256:…",
  "correlationId": "…",
  "sourceChannel": "WEB",
  "configurationVersionId": "…"
}
```

### Rules the envelope depends on

> **INV-AUD-005 — Every event carries tenant, actor, subject, UTC instant, event type,
> outcome and correlation identifier.**

> **INV-AUD-002 — Audit events cannot be updated or deleted through any application
> surface. Corrections are compensating events.**

> **INV-AUD-003 — Audit events never contain document bodies, arbitrary form payloads or
> unnecessary personal data.**

> **INV-AUD-004 — An event is emitted in the same transaction as the state change it
> records, or via an outbox guaranteeing eventual emission.**

> **INV-AUD-006 — Where an action is delegated, impersonated or elevated, both effective
> and originating actor are recorded.**

Two more, added with this catalogue:

> **INV-AUD-008 — Event types are a versioned contract. An event type's meaning and
> required fields never change in place; a changed shape gets a new
> `event_schema_version`, and older events remain interpretable under theirs.**

> **INV-AUD-009 — Events carry a deterministic total order within a tenant, so a
> reconstructed chronology is stable across regenerations.**

Ordering by `occurred_at` alone is not enough: two events can share a millisecond, and a
backdated governance fact can occur before an event recorded earlier. `sequence` breaks
the tie the same way every time, which is what makes INV-EVD-006 — regenerating a pack
yields the same substantive records — achievable at all.

"Append-only" here means *through the application contract*, enforced by revoking `UPDATE`
and `DELETE` from the application role. It is deliberately not marketed as cryptographic
immutability. Hash chaining, signed checkpoints or write-once storage are a separate,
later claim, and the glossary forbids conflating them.

## The catalogue

`MVP` events must exist in the Pilot. `V1` events accompany the capability that emits
them.

### Identity and organisation

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `user.provisioned` | A user is created, locally or by provisioning | `USER` | MVP |
| `user.updated` | Status, locale or identity binding changes | `USER` | MVP |
| `user.deactivated` | Authority ends; sessions revoked | `USER` | MVP |
| `user.reactivated` | A deactivated user is restored | `USER` | MVP |
| `session.revoked` | Sessions are terminated, by deactivation or by an administrator | `USER` | MVP |
| `group.created`, `group.membership_changed` | Group lifecycle and membership | `GROUP` | MVP |
| `legal_entity.created`, `legal_entity.closed` | Entity lifecycle | `LEGAL_ENTITY` | MVP |
| `org_unit.created`, `org_unit.changed`, `org_unit.deactivated` | Org structure changes | `ORG_UNIT` | MVP |
| `org_membership.changed` | A dated membership is opened, closed or corrected | `USER` | V1 |
| `governance_body.created`, `governance_body.dissolved` | Body lifecycle | `GOVERNANCE_BODY` | MVP |
| `body_membership.changed` | A dated seat is opened, closed or corrected | `GOVERNANCE_BODY` | MVP |

### Authorization

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `access.granted` | A grant is created — role or capability, at a scope | `ACCESS_GRANT` | MVP |
| `access.revoked` | A grant is revoked before expiry | `ACCESS_GRANT` | MVP |
| `access.expired` | A time-bounded grant reaches expiry and is materialised | `ACCESS_GRANT` | MVP |
| `access.denied` | An attempt on a resource configured as sensitive is refused | `DOCUMENT` | MVP |
| `access_request.submitted`, `access_request.approved`, `access_request.rejected` | Access-request lifecycle | `ACCESS_REQUEST` | V1 |
| `breakglass.started`, `breakglass.ended` | Elevation session lifecycle | `USER` | V1 |

`access.denied` is deliberately narrow. Logging every denied request in the governance
ledger would flood it with routine navigation noise; logging denials on documents the
tenant has marked sensitive is a security signal worth keeping.

### Document and version

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `document.created` | A Document and its baseline variant are created | `DOCUMENT` | MVP |
| `document.metadata_changed` | Register metadata that alters no obligation changes | `DOCUMENT` | MVP |
| `document.owner_changed` | Ownership moves, or becomes vacant | `DOCUMENT` | MVP |
| `document.type_changed` | Classification changes | `DOCUMENT` | MVP |
| `document.activated` | The first version becomes effective | `DOCUMENT` | MVP |
| `document.retired`, `document.restored` | Retirement and privileged restoration | `DOCUMENT` | MVP |
| `variant.created`, `variant.retired` | Variant lifecycle | `DOCUMENT_VARIANT` | V1 |
| `content_revision.created` | A draft revision is saved | `CONTENT_REVISION` | MVP |
| `version.created` | A pre-release version is opened | `DOCUMENT_VERSION` | MVP |
| `version.submitted` | Submission freezes a revision, digest and attachments | `DOCUMENT_VERSION` | MVP |
| `version.approved` | Every stage has satisfied its completion rule | `DOCUMENT_VERSION` | MVP |
| `version.rejected` | An approver terminated the candidate | `DOCUMENT_VERSION` | MVP |
| `version.cancelled` | A pre-release version was cancelled | `DOCUMENT_VERSION` | MVP |
| `version.published` | Visible, not yet normative | `DOCUMENT_VERSION` | MVP |
| `version.effective` | Normative from this instant | `DOCUMENT_VERSION` | MVP |
| `version.superseded` | A successor closed this version's interval | `DOCUMENT_VERSION` | MVP |
| `version.withdrawn` | Removed from effect, with a reason | `DOCUMENT_VERSION` | MVP |
| `version.materiality_changed` | Classification raised or lowered before approval | `DOCUMENT_VERSION` | MVP |
| `alignment.raised`, `alignment.resolved` | A derived variant or document type became stale, or was brought back into line | `ALIGNMENT_OBLIGATION` | V1 |

### Governance alerts

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `governance.policy_gap` | A withdrawal left no effective version for a scope. High severity. This is the event INV-EFF-005 names | `DOCUMENT_VARIANT` | MVP |
| `governance.conflict_detected` | Two same-specificity replacements collide, at publication or at resolution | `DOCUMENT` | V1 |
| `governance.digest_mismatch` | Stored content failed verification against its recorded digest | `DOCUMENT_VERSION` | MVP |

The third is the one nobody wants to emit and everybody needs. A digest mismatch is a
governance incident, never a data-repair task (see `versioning.md`).

### Approval

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `approval_run.started` | Submission opened a run against a frozen revision | `APPROVAL_RUN` | MVP |
| `approval_run.completed` | Every stage satisfied | `APPROVAL_RUN` | MVP |
| `approval_run.cancelled` | Cancelled with a reason | `APPROVAL_RUN` | MVP |
| `approval_run.blocked` | A stage became unsatisfiable | `APPROVAL_RUN` | MVP |
| `approval_stage.started`, `approval_stage.completed` | Serial stage boundaries | `APPROVAL_STAGE` | MVP |
| `approval_task.assigned` | A task was created for a resolved participant | `APPROVAL_TASK` | MVP |
| `approval_task.reassigned` | An administrator moved a task, with a reason | `APPROVAL_TASK` | V1 |
| `approval_task.delegated` | A holder delegated, within a time bound | `APPROVAL_TASK` | V1 |
| `approval_task.unresolvable` | The participant can no longer act | `APPROVAL_TASK` | MVP |
| `approval.approved` | An approval decision, by a user or a body | `APPROVAL_DECISION` | MVP |
| `approval.changes_requested` | Changes requested; the run terminates | `APPROVAL_DECISION` | MVP |
| `approval.rejected` | The candidate is rejected | `APPROVAL_DECISION` | MVP |
| `approval.corrected` | A compensating event correcting an earlier decision | `APPROVAL_DECISION` | MVP |
| `approval.reminded`, `approval.escalated` | Automation acted. Neither ever carries an approval | `APPROVAL_TASK` | MVP |

A `BODY_RESOLUTION` approval emits `approval.approved` with `actor.type = BODY`,
`recorded_by_user_id` set, and the resolution evidence the tenant's configuration requires
(INV-APR-021, INV-APR-024).

### Review

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `review.scheduled` | The next occurrence was calculated | `REVIEW_CASE` | MVP |
| `review.due` | The due instant passed | `REVIEW_CASE` | MVP |
| `review.started` | The owner opened it | `REVIEW_CASE` | MVP |
| `review.completed` | An outcome was recorded, with rationale | `REVIEW_CASE` | MVP |
| `review.overdue` | Overdue, and now a governance exception | `REVIEW_CASE` | MVP |
| `review.escalated` | Escalation fired | `REVIEW_CASE` | MVP |
| `review.cancelled` | The rule was suspended, or the document retired | `REVIEW_CASE` | MVP |

### Attestation

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `campaign.created` | A campaign was drafted against an exact version | `ATTESTATION_CAMPAIGN` | MVP |
| `campaign.preflight_failed` | Launch refused because targets lacked access | `ATTESTATION_CAMPAIGN` | MVP |
| `campaign.launched` | Audience resolved, assignments created | `ATTESTATION_CAMPAIGN` | MVP |
| `campaign.closed`, `campaign.cancelled` | Closure, with a reason where cancelled | `ATTESTATION_CAMPAIGN` | MVP |
| `assignment.created` | One principal's obligation, with its targeting basis | `ATTESTATION_ASSIGNMENT` | MVP |
| `assignment.overdue` | The due instant passed with no response | `ATTESTATION_ASSIGNMENT` | MVP |
| `assignment.cancelled` | Departure, or campaign cancellation | `ATTESTATION_ASSIGNMENT` | MVP |
| `assignment.exempted` | An authorised exemption, with reason and expiry | `ATTESTATION_ASSIGNMENT` | MVP |
| `attestation.acknowledged` | A response, bound to version, digest and statement | `ATTESTATION_RESPONSE` | MVP |
| `attestation.declined` | An explicit refusal, with reason | `ATTESTATION_RESPONSE` | MVP |
| `attestation.reminded` | A reminder was sent | `ATTESTATION_ASSIGNMENT` | MVP |

### Waivers

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `waiver.submitted`, `waiver.approved`, `waiver.rejected` | Request lifecycle | `WAIVER` | V1 |
| `waiver.expired`, `waiver.revoked` | Closure | `WAIVER` | V1 |

### Evidence and retention

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `evidence_pack.requested` | A pack was requested, with its parameters | `EVIDENCE_PACK` | MVP |
| `evidence_pack.generated` | Assembly succeeded; manifest digest recorded | `EVIDENCE_PACK` | MVP |
| `evidence_pack.failed` | Assembly failed. Nothing partial is made available | `EVIDENCE_PACK` | MVP |
| `evidence_pack.downloaded` | Someone took a copy | `EVIDENCE_PACK` | MVP |
| `evidence_pack.expired` | The download link lapsed | `EVIDENCE_PACK` | V1 |
| `export.generated` | Any other bulk export of governed data | `EXPORT` | MVP |
| `retention.changed` | A retention rule was created or altered | `RETENTION_RULE` | V1 |
| `retention.disposed` | Records were disposed under a rule | `RETENTION_RULE` | V1 |
| `retention.blocked_by_hold` | Disposal was prevented by a legal hold | `LEGAL_HOLD` | V1 |
| `legal_hold.applied`, `legal_hold.released` | Hold lifecycle | `LEGAL_HOLD` | V1 |

### Configuration and administration

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `configuration.changed` | Any tenant configuration change, with before and after (INV-CFG-004) | `CONFIGURATION_VERSION` | MVP |
| `configuration.weakened` | The change removed or reduced a control (INV-CFG-005) | `CONFIGURATION_VERSION` | V1 |
| `profile.applied` | A governance profile was copied into the tenant | `TENANT` | MVP |
| `document_type.changed` | Rank, mandated authority or defaults changed | `DOCUMENT_TYPE` | MVP |
| `workflow_template.published` | A new immutable template version | `WORKFLOW_TEMPLATE_VERSION` | V1 |
| `attestation_statement.created` | A new statement version | `ATTESTATION_STATEMENT` | MVP |
| `security_setting.changed` | Session policy, authentication settings | `TENANT` | MVP |
| `integration.changed` | API clients, webhooks, provisioning | `API_CLIENT` | V1 |

### Sensitive reads

Off by default and configurable per tenant, because read logging is where a compliance
product most easily becomes surveillance.

| Event | Emitted when | Subject | Phase |
|---|---|---|---|
| `document.sensitive_viewed` | A document the tenant marked sensitive was opened | `DOCUMENT_VERSION` | V1 |
| `audit.exported` | The ledger itself was exported | `EXPORT` | MVP |
| `evidence.accessed` | Evidence was viewed without downloading a pack | `EVIDENCE_PACK` | V1 |

## Retention

There is no universal statutory period for any of this. GDPR requires personal data to be
kept in identifiable form no longer than necessary for its purpose, which is a rule about
justification rather than a number.

These are **product defaults**, configurable per record class by the customer, and the
product never claims a legally required period (INV-RET-003).

| Record class | Default | Rationale |
|---|---:|---|
| Released version evidence | 7 years after supersession or retirement | Long governance history is what regulated customers need |
| Approval and review evidence | 7 years | Tied to the controlled version's history |
| Attestation evidence | 7 years, or the customer's employment schedule | Needed for proof, and contains personal data |
| Waiver evidence | 7 years after closure | Governance evidence |
| Security and administrative audit | 2 years | Investigation value, without indefinite employee telemetry |
| Reader-view telemetry | Disabled by default; 12 months where enabled | The highest minimisation concern in the product |
| Draft and autosave history | 12 months after finalisation | Little reason to keep indefinitely |
| Evidence-pack artefacts | Configurable. The manifest may outlive the binary | Avoids duplicating concentrated personal data |

Legal hold overrides scheduled disposal for as long as it stands (INV-RET-001), and grants
visibility to nobody (INV-AUTH-009).

## What is not an audit event

| Not an event | Why |
|---|---|
| A page view of an ordinary document | Read telemetry is surveillance unless the tenant has a stated need |
| A search query | Same, and it reveals what people are worried about |
| A draft keystroke or autosave | `content_revision.created` covers what matters |
| A notification send | An operational record on `Notification`, correlated by `triggering_event_id` |
| A failed login | Security logging, not the governance ledger (INV-AUD-007) |
| A scheduler tick that changed nothing | Events record transitions, not attempts to find one |
