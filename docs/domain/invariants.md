# Invariant Registry

Every rule the system must never break, with a stable identifier.

**How this registry is used.** Implementation tickets cite invariant IDs. Test names
contain them. CI fails when any `INV-*` entry has no test referencing it. Pull requests
that touch domain behaviour list the IDs they rely on.

```text
spec section  →  INV-ID  →  test name  →  issue  →  PR  →  ADR
```

IDs are permanent. An invariant that is superseded is marked `SUPERSEDED BY INV-XXX-nnn`
and kept; its number is never reused.

**Test level** — `U` unit · `I` integration (real database) · `P` property-based ·
`E` end-to-end (Playwright). Most invariants need more than one.

**Phase** — `MVP` must hold in the Pilot · `V1` Commercial V1 · a phase never weakens an
invariant already in force.

---

## INV-TEN — Tenant isolation

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-TEN-001 | No query, job, export, webhook or search path returns data from a tenant other than the authenticated principal's | The single most severe possible defect in a multi-tenant compliance product | I, E | MVP |
| INV-TEN-002 | A valid identifier from another tenant behaves as **not found**, never as forbidden | "Forbidden" confirms the resource exists, leaking its existence and often its type | I, E | MVP |
| INV-TEN-003 | No entity may hold a foreign key to a record in another tenant | Makes cross-tenant leakage structurally impossible rather than defended per query | I | MVP |
| INV-TEN-004 | Tenant scoping is enforced below the presentation layer, so background jobs and APIs inherit it | UI-only tenancy is the classic way this fails | I | MVP |
| INV-TEN-005 | Error messages, timing, result counts and search facets reveal nothing about other tenants' resources | Side-channel disclosure is still disclosure | I, E | MVP |

## INV-DOC — Document identity and lifecycle

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-DOC-001 | A `Document` never carries normative content; content lives only on versions | Keeps identity stable across all revisions | U, I | MVP |
| INV-DOC-002 | Document lifecycle is only `Planned → Active → Retired`; draft, review and approval states belong to versions | Prevents the two lifecycles being conflated | U | MVP |
| INV-DOC-003 | Restoring a retired Document never reactivates a historical version; it requires a new controlled version | Retirement must not be silently undoable | U, I | MVP |
| INV-DOC-004 | A Document is never physically deleted while governed records or evidence reference it | Destroying evidence is the opposite of what the product is for | I | MVP |
| INV-DOC-005 | `document_type_id` is authoritative for type; the title is never parsed to derive type or version | Titles lie — "SCA Guidelines v2" is often a Manual | U | MVP |
| INV-DOC-006 | Every Document has exactly one owner, or is visibly flagged as an ownership exception | Unowned documents are how estates rot | I, E | MVP |
| INV-DOC-030 | Publishing a new Governing Framework version marks every `DocumentType` deriving authority from the prior version as requiring alignment review, and never rewrites any mandated authority | The constitution changing must prompt a human, not silently re-govern the estate | I | V1 |

## INV-VER — Versioning and immutability

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-VER-001 | Multiple draft saves produce Content Revisions, never released Versions | Otherwise autosave manufactures fake policy versions | U, I | MVP |
| INV-VER-002 | Submission freezes exactly one Content Revision, its digest and its governed attachments | Approvers must not review a moving target | I, E | MVP |
| INV-VER-003 | Normative content of an approved, published, effective, superseded or withdrawn Version can never be mutated by any code path | The core promise of the product | U, I, E | MVP |
| INV-VER-004 | Content is not editable while an Approval Run is active | Prevents the SharePoint failure mode where editing silently voids approval | I, E | MVP |
| INV-VER-005 | An erroneous released Version is withdrawn or superseded with a reason; never edited, never deleted | No destructive correction | I | MVP |
| INV-VER-006 | Human-facing version labels ("3.1") are never used as identity or for ordering; a monotonic internal sequence is | Customers use incompatible display conventions | U | MVP |
| INV-VER-007 | Fields an approver relied upon — body, incorporated attachments, applicability, variant relationship, materiality, effective date — are immutable after approval | These change what was actually approved | U, I | MVP |
| INV-VER-008 | Administrative fields that do not alter obligations may change post-approval, and every such change emits an audit event | Avoids version churn for a tag edit, without losing the trail | I | MVP |
| INV-VER-009 | The content digest covers canonicalised content **and** all governed attachments, under a recorded canonicalisation schema version | A digest that omits attachments proves less than it appears to | U, P | MVP |

## INV-EFF — Effectivity and supersession

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-EFF-001 | Published and Effective are distinct states; a Version is not normative before its effective instant | Advance distribution is a deliberate product capability | U, I, E | MVP |
| INV-EFF-002 | For a given Document, variant scope and instant, at most one Version is Effective | The system must always have exactly one answer to "what applies" | I, P, E | MVP |
| INV-EFF-003 | Supersession is atomic: the successor becomes effective and the predecessor's effective interval closes in one transaction | A gap or an overlap are both governance failures | I, P | MVP |
| INV-EFF-004 | Withdrawal never causes a superseded Version to become effective again | Silent resurrection of withdrawn guidance is dangerous | I, E | MVP |
| INV-EFF-005 | Withdrawal leaving no effective Version emits a high-severity `policy_gap` event rather than falling back | The gap must be loud, not papered over | I, E | MVP |
| INV-EFF-006 | Effectivity is derived from applicability and dated intervals, never from a mutable `is_current` flag | Mutable current-flags drift and cannot answer historical questions | I | MVP |
| INV-EFF-007 | A scheduler firing twice produces exactly one `version.effective` event | At-least-once delivery must not duplicate governance transitions | I | MVP |
| INV-EFF-008 | A Version withdrawn before its effective instant never becomes effective, including under a race with the scheduler | Checked transactionally against authoritative state | I | MVP |
| INV-EFF-009 | Retroactive effective dates require elevated capability and a recorded reason | Backdating rewrites who was governed when | I, E | V1 |

## INV-APR — Approval

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-APR-001 | Every Approval Decision references an exact Content Revision and its digest | An approval that cannot name what it approved is not evidence | U, I, E | MVP |
| INV-APR-002 | No elapsed time, timeout or escalation ever results in automatic approval | Automation reminds and escalates; it never invents consent | U, I, E | MVP |
| INV-APR-003 | Requesting changes returns work to drafting and terminates the submission snapshot | Approval cannot survive the content it approved | I, E | MVP |
| INV-APR-004 | Resubmission creates a fresh Approval Run; prior decisions remain visible as history and never carry over | Decisions do not transfer to different bytes | I, E | MVP |
| INV-APR-005 | A deactivated, expired or unauthorised approver leaves the task unresolved; the system never substitutes anyone | Silent substitution destroys accountability | I, E | MVP |
| INV-APR-006 | Reassignment and delegation are explicit, authorised and audited, recording both effective and originating actor | Delegation must be visible in evidence | I | V1 |
| INV-APR-007 | Approval Decisions are immutable; corrections create compensating events | History is not editable | I | MVP |
| INV-APR-008 | A serial stage cannot begin before its predecessor satisfies its completion rule | Ordering is a governance guarantee, not a UI convenience | U, I | MVP |
| INV-APR-009 | Concurrent decisions are idempotent; a completion threshold is satisfied exactly once | Two approvers clicking simultaneously must not double-complete | I, E | MVP |
| INV-APR-010 | A Workflow Template Version is immutable; editing creates a new version and never alters active or historical runs | Otherwise an admin edit rewrites the meaning of past approvals | I | V1 |
| INV-APR-011 | Where configured, separation of duties prevents the author being the sole final approver | Standard control expectation in regulated organisations | I, E | V1 |
| INV-APR-020 | A workflow may add approval requirements beyond its Document Type's mandated authority, never fewer | Makes the governing framework binding rather than advisory | U, I, E | MVP |
| INV-APR-021 | A `BODY_RESOLUTION` decision carries a resolution reference, a resolution date and the authorised recording user; the recorder is never presented as the approver | "The Management Board approved" is a different fact from "five people clicked approve" | U, I, E | MVP |
| INV-APR-022 | `resolution_date` may precede `recorded_at`, but never precedes submission of the revision it approves | A board cannot have resolved on text that did not yet exist | U, I | MVP |
| INV-APR-023 | Recording a body resolution requires capability to act for that specific body | Otherwise anyone can assert a board decision | I, E | MVP |

## INV-AUTH — Authorization

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-AUTH-001 | Default deny: absent an applicable grant, access is refused | The only safe default | U, I | MVP |
| INV-AUTH-002 | An explicit deny defeats any inherited or direct allow | Sensitive documents and conflict-of-interest cases depend on it | U, I, E | MVP |
| INV-AUTH-003 | A grant with a validity interval stops authorising at expiry, evaluated during the authorization check itself | A cleanup job is not an access control | U, I, E | MVP |
| INV-AUTH-004 | An expired grant cannot be prolonged by a cached session or open page | Session caching must not outlive entitlement | I, E | V1 |
| INV-AUTH-005 | Applicability never implies access; being governed by a document grants no permission | Two different questions, permanently separate | U, I | MVP |
| INV-AUTH-006 | Attestation assignment never implicitly grants read access | Otherwise mis-targeting a campaign becomes a disclosure mechanism | I, E | MVP |
| INV-AUTH-007 | A campaign cannot launch while any target lacks access to the exact Version — preflight fails | Never resolve this by silently granting access | I, E | MVP |
| INV-AUTH-008 | A narrow direct grant exposes only its target and never enables browsing its ancestors | "One document, not the whole space" is a core use case | I, E | MVP |
| INV-AUTH-009 | Legal hold grants no visibility to anyone | Retention and access are independent axes | U, I | V1 |
| INV-AUTH-010 | API authorization is identical to UI authorization; neither path is more permissive | Divergence here is how products leak | I | MVP |
| INV-AUTH-011 | Search enforces authorization at retrieval, never trusting index filtering alone | A stale index must not leak withdrawn or revoked content | I, E | MVP |
| INV-AUTH-012 | Restricted titles, snippets, breadcrumbs, counts and facets never appear to unauthorised principals | Metadata disclosure is disclosure | I, E | MVP |
| INV-AUTH-013 | Privilege elevation and break-glass are time-bounded, justified and separately audited | Standing broad access is unacceptable to security reviewers | I, E | V1 |
| INV-AUTH-014 | Deactivating a user revokes active sessions and prevents new governed actions, while historical attribution is preserved | Offboarding must be immediate and non-destructive | I, E | MVP |

## INV-APL — Applicability and variants

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-APL-001 | Applicability resolution is deterministic: identical inputs always produce an identical result set | Non-determinism here makes every downstream claim unprovable | P, I | MVP |
| INV-APL-002 | Exactly one baseline-or-replacement branch resolves for a given scope and instant | Two competing governing documents is not an answer | P, I, E | V1 |
| INV-APL-003 | Two replacements of equal specificity claiming the same scope and interval block publication | Fail closed rather than pick a winner | I, E | V1 |
| INV-APL-004 | If an impossible conflict reaches the reader path, resolution fails with a governance error and never selects arbitrarily | Failing loudly beats being confidently wrong | I, E | V1 |
| INV-APL-005 | Supplements coexist with the resolved baseline or replacement; they never replace it | Distinct relationship semantics | U, I | V1 |
| INV-APL-006 | Language selection happens only after normative scope resolution; a translation never alters legal scope | Choosing Finnish must not change which rules apply | U, I, E | V1 |
| INV-APL-007 | Publishing a master version never auto-merges, auto-translates or overwrites derived variants; it marks them alignment-required | Controlled content is never rewritten by machine | I, E | V1 |
| INV-APL-008 | Alignment-required status cannot be cleared without a recorded governance action | Otherwise staleness is dismissed rather than resolved | I, E | V1 |
| INV-APL-009 | Historical resolution uses memberships, entity structure and rules as they were at the requested instant, not as they are today | The whole point of point-in-time reconstruction | I, P, E | V1 |

## INV-REV — Review

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-REV-001 | An overdue review never changes which Version is effective | A missed deadline must not create a policy vacuum | U, I, E | MVP |
| INV-REV-002 | Overdue review produces a visible governance exception and escalation | Late must be loud | I, E | MVP |
| INV-REV-003 | A `NO_CHANGE` outcome records a completed review without creating a new Version | Reviewing and revising are different acts | I, E | MVP |
| INV-REV-004 | Completing a review schedules the next occurrence deterministically from the configured anchor | Silent cadence drift defeats the control | U, I | MVP |
| INV-REV-005 | Review Cases are immutable once completed | They are evidence | I | MVP |

## INV-ATT — Attestation

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-ATT-001 | A campaign binds exactly one Document Version, never a Document or "the latest" | Otherwise nobody can say what was acknowledged | U, I, E | MVP |
| INV-ATT-002 | A response records the exact Version, its content digest, the statement wording and version presented, the responder and the timestamp | This is the evidence | I, E | MVP |
| INV-ATT-003 | A response after the due instant is recorded as `COMPLETED_LATE` and never rewritten as on-time | Falsifying timeliness destroys the record's value | I, E | MVP |
| INV-ATT-004 | Each assignment retains why the principal was targeted — entity, org unit, role, group or explicit | Auditors ask how the audience was derived | I | MVP |
| INV-ATT-005 | Departure cancels outstanding obligations without deleting completed responses or the record that the obligation existed | History does not disappear when someone resigns | I, E | MVP |
| INV-ATT-006 | Changing departments or groups never rewrites an existing snapshot campaign's assignments | Snapshot means snapshot | I, E | MVP |
| INV-ATT-007 | Responses are append-only; a correction adds evidence rather than overwriting it | Same rule as approvals | I | MVP |
| INV-ATT-008 | A new campaign never alters an earlier campaign, nor implies earlier readers acknowledged the new text | Re-attestation is a new fact | I, E | MVP |
| INV-ATT-009 | Material changes generate re-attestation for the affected audience only | Compliance fatigue is a real product failure | I, E | V1 |
| INV-ATT-010 | Duplicate notification delivery never produces duplicate assignments or duplicate governance transitions | At-least-once email, exactly-once obligation | I | MVP |

## INV-AUD — Audit

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-AUD-001 | Every governance-relevant transition emits exactly one canonical audit event | Missing events make evidence incomplete; duplicates make it untrustworthy | I | MVP |
| INV-AUD-002 | Audit events cannot be updated or deleted through any application surface; corrections are compensating events | Append-only is the contract | I | MVP |
| INV-AUD-003 | Audit events never contain document bodies, arbitrary form payloads or unnecessary personal data | Duplicating content into the ledger multiplies privacy exposure | U, I | MVP |
| INV-AUD-004 | An event is emitted in the same transaction as the state change it records, or via an outbox guaranteeing eventual emission | A committed change with no event is an unprovable change | I | MVP |
| INV-AUD-005 | Every event carries tenant, actor, subject, UTC instant, event type, outcome and correlation identifier | The minimum for reconstruction | U, I | MVP |
| INV-AUD-006 | Where an action is delegated, impersonated or elevated, both effective and originating actor are recorded | Otherwise privileged action is invisible | I | V1 |
| INV-AUD-007 | Business governance events and low-level security or observability logs remain separately modelled | The evidence ledger is not a request log | I | MVP |

## INV-EVD — Evidence

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-EVD-001 | An evidence pack is assembled from authoritative records, never from rendered screens or cached summaries | Screenshots are not evidence | I, E | MVP |
| INV-EVD-002 | Every pack contains a manifest with schema version, generation and as-of instants, requester, included objects and per-file digests | Without a manifest a pack cannot be verified | I, E | MVP |
| INV-EVD-003 | Every file in a pack validates against its recorded digest | Integrity must be checkable outside the application | I, E | MVP |
| INV-EVD-004 | A partially generated pack is marked failed and never made available as complete | An incomplete pack presented as complete is worse than none | I, E | MVP |
| INV-EVD-005 | Requesting, generating, failing and downloading a pack each emit audit events | Evidence access is itself evidence | I, E | MVP |
| INV-EVD-006 | Regenerating a pack for the same specification yields the same substantive records; only packaging metadata may differ | Determinism is what makes it evidence | I, P | V1 |
| INV-EVD-007 | An as-of query resolves the Version, memberships and audience that were in force at that instant | Historical reconstruction, not a filter over today | I, P, E | V1 |
| INV-EVD-008 | Pack download links expire, and expiry is enforced at retrieval | Packs contain concentrated personal data | I | V1 |

## INV-RET — Retention and legal hold

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-RET-001 | An active legal hold blocks disposal, and the block emits an event | Preservation obligations override schedules | I | V1 |
| INV-RET-002 | Releasing a hold resumes normal eligibility evaluation; it never triggers immediate destruction | Release is not a delete button | I | V1 |
| INV-RET-003 | Retention is configured per record class by the customer; the product ships defaults and never claims a legally required period | No universal statutory period exists | I | V1 |
| INV-RET-004 | Pseudonymising an identity preserves governance chronology and record linkage | Erasure requests must not destroy the audit chain | I | V1 |

## INV-TIME — Time and concurrency

| ID | Invariant | Why it matters | Test | Phase |
|---|---|---|---|---|
| INV-TIME-001 | All authoritative instants are stored in UTC; local time is a presentation concern | Deadlines across timezones are otherwise unresolvable | U, I | MVP |
| INV-TIME-002 | Scheduled transitions behave correctly across DST boundaries and timezone configuration changes | A classic source of off-by-one-hour governance errors | U, P | MVP |
| INV-TIME-003 | Every mutating operation is protected by optimistic concurrency or an idempotency key; a stale write conflicts rather than overwrites | Silently overwriting someone's governance decision is unacceptable | I, E | MVP |
| INV-TIME-004 | A retried request returns the original logical result rather than performing the action twice | Browsers and networks retry | I, E | MVP |
