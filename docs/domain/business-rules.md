# Business Rules, Edge Cases and Failure Modes

The cases that decide whether this is a system of record or a document repository with
workflow attached. Both source blueprints carried a table of these; this chapter merges
them, resolves the overlaps, and states the required behaviour in the canonical
vocabulary.

Nothing here is new law. Every row resolves to invariants already registered — this is the
chapter that says *what that means when it actually happens on a Tuesday afternoon*.

## Time, concurrency and retries

| Situation | Required behaviour | Invariants |
|---|---|---|
| Two approvers decide simultaneously on the last outstanding task | The decision transaction is idempotent. The completion threshold is satisfied exactly once, one `version.approved` is emitted | INV-APR-009, INV-TIME-003 |
| The effectivity scheduler fires twice for one version | Exactly one `version.effective`. The second attempt is a no-op, not a second transition | INV-EFF-007 |
| A scheduled version is withdrawn seconds before its effective instant | The scheduler checks authoritative state inside the transaction. The withdrawn version never becomes effective | INV-EFF-008 |
| Two versions race to become effective for one scope | One succeeds, one conflicts. Never both, and never a gap | INV-EFF-002, INV-EFF-003 |
| A browser retries an approval submission | The idempotency key returns the original logical result rather than recording a second decision | INV-TIME-004 |
| Two administrators edit the same draft | The stale write conflicts. Silently overwriting someone's governance work is not an acceptable outcome of a race | INV-TIME-003 |
| Users are in different timezones | Instants are stored in UTC. Deadlines display in the user's zone, with the zone shown | INV-TIME-001 |
| A due date falls inside a DST transition | Calculated from the calendar rule and stored as a UTC instant, never shifted by an hour because a boundary moved | INV-TIME-002 |
| A tenant changes its timezone configuration | Future scheduled instants are recomputed from calendar rules. Past instants are historical facts and do not move | INV-TIME-001, INV-TIME-002 |
| An interval's end and the next interval's start coincide | Intervals are half-open `[from, until)`. No instant belongs to two of them | INV-TIME-005 |

## Joiners, movers and leavers

| Situation | Required behaviour | Invariants |
|---|---|---|
| An employee leaves | Sessions revoked, grants stop authorising, future obligations cancelled, historical records preserved and still attributed | INV-AUTH-014, INV-ATT-005 |
| An approver leaves mid-run | The task becomes unresolvable and requires authorised reassignment. Nothing auto-approves and nobody is substituted | INV-APR-005, INV-APR-013 |
| A document owner leaves | The document is immediately visible as an ownership exception, and routed to a remediation queue | INV-DOC-006 |
| An employee moves from Estonia to Poland | Applicability re-resolves from the new membership. New obligations appear, irrelevant ones stop applying, and every historical record stands | INV-APL-009, INV-ORG-002 |
| Someone changes department during an open snapshot campaign | Their assignment is unchanged. Snapshot means snapshot | INV-ATT-006 |
| A user is a member of two legal entities | Obligations resolve per context and are labelled by context. This is not a conflict | INV-APL-001 |
| A user's temporary grant expires while their page is open | The next authorization check denies. No logout, no cleanup job required | INV-AUTH-003, INV-AUTH-004 |
| A deactivated user is reinstated | A new grant is required. Reactivation restores identity, not entitlement | INV-AUTH-001 |
| An identity provider removes a user | Same as deactivation, propagated. Historical evidence is untouched | INV-AUTH-014 |
| A legal entity is closed | Marked inactive. Never hard-deleted while any governed record references it, and historical resolution still resolves through it | INV-ORG-003 |
| A governance body is dissolved | Marked dissolved. Its past resolutions remain valid and attributed to it | INV-ORG-005 |

## Content, drafting and approval

| Situation | Required behaviour | Invariants |
|---|---|---|
| An author saves a draft ten times | Ten content revisions, no released versions | INV-VER-001 |
| An author edits while an approval run is active | Refused. Not silently cancelled, not accepted-and-invalidated | INV-VER-004 |
| An author edits after one approver has decided | Impossible while the run is active. Reaching new content requires requesting changes or cancelling, and prior decisions never carry over | INV-VER-004, INV-APR-004 |
| Changes are requested | The run terminates, the frozen revision stays frozen, the next edit creates revision *n+1* | INV-APR-003, INV-VER-010 |
| A candidate is rejected | Terminal. Continuing requires deliberately creating a new version | — `document-lifecycle.md` |
| Someone tries to open a second draft for one variant | Refused while a pre-release version exists. Terminal candidates do not block | INV-VER-012 |
| A workflow is configured that omits the type's mandated approver | The template cannot be published, and a run cannot start under it | INV-APR-020 |
| A template is edited while runs are in flight | Those runs continue under the version they started with | INV-APR-010, INV-APR-012 |
| A group's membership changes mid-run | The run uses the participants resolved at start | INV-APR-012 |
| A stage becomes unsatisfiable — fewer eligible approvers than its threshold | The run blocks and raises a governance exception. The threshold is never reduced to fit | INV-APR-013 |
| A delegate lacks the approval capability | They cannot decide. Delegation moves a task, not a capability | INV-APR-014 |
| An approval deadline passes | Reminders and escalation. Never approval | INV-APR-002 |
| A board resolution is recorded with a resolution date before submission | Refused. A board cannot have resolved on text that did not yet exist | INV-APR-022 |
| Someone records a body's decision without capability for that body | Refused | INV-APR-023 |
| A decision was recorded against the wrong body | A compensating event corrects it. The original remains | INV-APR-007 |
| A change is classified `EDITORIAL` but altered a deadline | Deterministic warnings fire, visible to the author and every approver. The classification is a recorded human choice, not an inference | INV-VER-014 |
| Someone lowers materiality to avoid re-attestation | Requires elevated capability and a recorded reason. Raising it requires resubmission under the correct workflow | INV-VER-015 |

## Effectivity, supersession and withdrawal

| Situation | Required behaviour | Invariants |
|---|---|---|
| A version is published before its effective date | Visible to those permitted, and not normative. Labelled unmistakably | INV-EFF-001 |
| A successor becomes effective | Predecessor's interval closes in the same transaction. No gap, no overlap | INV-EFF-003 |
| An effective version is withdrawn and nothing replaces it | A high-severity `governance.policy_gap` event. The predecessor is **not** resurrected | INV-EFF-004, INV-EFF-005 |
| A withdrawn version's text is needed again | A new controlled version, approved again. Withdrawal is not undone | — `document-lifecycle.md` |
| A typo is found in the effective version | A new version supersedes it. The effective version is never edited | INV-VER-003, INV-VER-005 |
| An effective date is entered retroactively | Elevated capability and a recorded reason, with a warning about the applicability and attestation consequences | INV-EFF-009 |
| A reader has a page open when a successor takes effect | The next resolution returns the new version. An attestation in progress stays bound to the version presented | INV-ATT-002 |
| Someone asks for "the current version" of a retired document | The register answers with its history and the fact of retirement. There is no current version, and the system says so | INV-EFF-006 |
| A document is retired while a version is still effective | Refused. Withdraw first, deliberately | INV-DOC-008 |
| An administrator tries to delete a document | There is no such capability while governed records or evidence reference it | INV-DOC-004 |

## Applicability and variants

| Situation | Required behaviour | Invariants |
|---|---|---|
| Two same-specificity replacements claim one scope and interval | The second publication is blocked, naming the collision | INV-APL-003 |
| Such a conflict nevertheless reaches a reader | Resolution fails with a governance error and raises an alert. Never an arbitrary pick | INV-APL-004 |
| A supplement and a replacement both match | The replacement resolves as the normative branch; the supplement is added alongside it | INV-APL-005 |
| A reader selects Finnish | Language is chosen after normative resolution. Legal scope is identical | INV-APL-006 |
| A group baseline reaches v4 while a local adaptation derives from v3 | The local variant stays effective and is marked alignment-required. Nothing is merged, translated or overwritten | INV-APL-007 |
| Someone wants the stale flag gone | Only a recorded governance action clears it — adoption, a completed review, or a justified divergence | INV-APL-008 |
| A subsidiary wants to replace a mandatory group policy | Refused. A supplement, or an approved waiver, is the route | INV-APL-012 |
| An auditor asks what applied to a branch in February 2027 | Resolved from memberships, entity structure and rules as they were then | INV-APL-009 |
| A document is filed in the "Security" Space | That fact governs nobody and permits nothing | INV-APL-010, INV-AUTH-015 |

## Distribution and attestation

| Situation | Required behaviour | Invariants |
|---|---|---|
| A campaign targets someone without read access | Preflight fails; launch is refused. Access is never granted implicitly to resolve it | INV-AUTH-006, INV-AUTH-007 |
| A campaign is pointed at "the latest version" | Not expressible. Campaigns bind an exact version | INV-ATT-001 |
| A response arrives after the due instant | `COMPLETED_LATE`, permanently. Never rewritten as on-time | INV-ATT-003 |
| A deadline is extended after some people were late | Already-recorded outcomes are untouched | INV-ATT-011 |
| The notification provider sends twice | One assignment, one obligation, one transition | INV-ATT-010 |
| An audience rule catches somebody three times | One assignment | INV-ATT-012 |
| A material update ships | Re-attestation for the affected audience only. Re-attesting everybody for every change is how acknowledgement becomes meaningless | INV-ATT-009 |
| A translation is corrected with no normative change | No new attestation by default | INV-ATT-009 |
| Someone declines to acknowledge | Recorded with a reason and escalated. A decline is a governance fact, not a missing response | INV-ATT-007 |
| A campaign closes while a reader is submitting | The server decides by transaction order and reports the authoritative outcome. The interface never fabricates success | INV-TIME-003 |
| Someone leaves with an outstanding assignment | `CANCELLED_DEPARTURE`, retaining the record that the obligation existed | INV-ATT-005 |
| An administrator wants to mark an assignment complete on someone's behalf | Not available. Exemption, with authority, reason and expiry, is the honest mechanism | INV-ATT-007 |

## Access and disclosure

| Situation | Required behaviour | Invariants |
|---|---|---|
| A user presents another tenant's identifier | Not found. No metadata, no timing difference, no facet count | INV-TEN-002, INV-TEN-005 |
| A document is restricted but appears in a count or facet | It must not. Metadata disclosure is disclosure | INV-AUTH-012 |
| The search index lags behind a withdrawal or a revoked grant | Authorization and current state are applied at retrieval. A stale index never leaks | INV-AUTH-011 |
| Someone is granted one document | They see that document. Not its Space, not its siblings, not its ancestors | INV-AUTH-008 |
| A broadly authorised user is conflict-restricted from one document | The explicit deny defeats the inherited allow, regardless of specificity | INV-AUTH-002 |
| An external auditor needs evidence | Scoped, expiring, read-only grants. Not a tenant-wide administrator role | INV-AUTH-003, INV-AUTH-013 |
| A support engineer needs production access | No standing access. A justified, expiring, individually audited elevation session that the customer can see | INV-AUTH-013, INV-AUD-006 |
| A legal hold is in force | Disposal is blocked. Visibility changes for nobody | INV-AUTH-009, INV-RET-001 |
| A document applies to someone who cannot read it | A governance defect, surfaced as an exception. Applicability never grants access to fix it | INV-AUTH-005 |
| An API client asks for something the UI would refuse | Refused identically. Neither path is more permissive | INV-AUTH-010 |
| A background job processes tenant data | Runs as an explicit principal with explicit capabilities, tenant-scoped below the presentation layer | INV-TEN-004 |

## Evidence, retention and privacy

| Situation | Required behaviour | Invariants |
|---|---|---|
| Evidence generation partly fails | The pack is marked failed. Nothing partial is offered as complete | INV-EVD-004 |
| The same pack specification is generated twice | The same substantive records. Only packaging metadata differs | INV-EVD-006 |
| A recipient wants to verify a pack without the vendor | Per-file digests and `SHA256SUMS` make it checkable with a hash utility | INV-EVD-003 |
| Stored content fails verification against its recorded digest | A governance incident. The version is quarantined from resolution and investigated. The digest is never recomputed to match | INV-VER-009 |
| A requester's scope is narrower than the pack they asked for | The pack is generated without the records they cannot read, and the manifest records the exclusion | INV-EVD-010 |
| A pack link is shared after expiry | Refused at retrieval | INV-EVD-008 |
| A data subject requests erasure while attestation history exists | The customer decides the lawful disposition. The product supports pseudonymisation that preserves chronology and linkage | INV-RET-004 |
| A record becomes retention-eligible under an active hold | Marked eligible-but-held. Not destroyed, and the block is an event | INV-RET-001 |
| A hold is released | Normal eligibility evaluation resumes. Release is not a delete button | INV-RET-002 |
| Someone asks for IP addresses on attestations "for the auditors" | Off by default. A tenant with a documented need can enable it; "an auditor might want it" is not a lawful basis | INV-AUD-003 |
| A customer asks what the legally required retention period is | The product ships defaults and never claims a statutory period. Retention is configured per record class by the customer | INV-RET-003 |

## Configuration

| Situation | Required behaviour | Invariants |
|---|---|---|
| A tenant wants to disable "no timeout auto-approves" | Not configurable. Nothing in the registry has a switch | INV-CFG-001 |
| We improve a shipped governance profile | Existing tenants are unaffected. Profiles are copied, never linked | INV-CFG-002 |
| A control is weakened — a mandated approver removed, a required evidence field disabled, retention shortened | Elevated capability and a recorded reason. The old rule and the moment it changed both stay in evidence | INV-CFG-005 |
| Configuration changes today | Completed governance records are unaffected. History is interpreted under the rules that existed then | INV-CFG-003, INV-CFG-006 |
| The Governing Framework is superseded | Every document type deriving authority from the prior version is flagged for alignment review. No mandated authority is rewritten | INV-DOC-030 |

## Messy estates

Real customers arrive with four years of drift. The product's job is to make it visible,
never to refuse the import.

| Situation | Required behaviour | Invariants |
|---|---|---|
| A document titled "SCA Guidelines v2" is, in the taxonomy, a Manual | `document_type_id` is authoritative. The title is a label | INV-DOC-005 |
| A title appears to contain a version number | A register-hygiene observation. Never an input to version resolution, and never a blocker | INV-DOC-005 |
| An imported document has no owner | Imported, and immediately visible as an ownership exception | INV-DOC-006 |
| An imported document has no approval history | Imported with its provenance recorded as *migrated, no prior evidence*. The pack says so rather than implying an approval happened | INV-EVD-001 |
| A customer's version labels are inconsistent — `v3`, `3.0`, `Rev C` | Stored as display labels. Ordering uses the internal sequence | INV-VER-006 |
| An import is retried after a partial failure | Resumable and idempotent. No duplicate documents | INV-TIME-004 |

## The fail-closed register

Every place the system refuses rather than guesses. Each of these is a deliberate decision
to be unhelpful in the moment in order to be correct.

| Refuses | Rather than |
|---|---|
| Ambiguous applicability resolution | Picking the more recently published variant |
| A stage whose completion rule cannot be satisfied | Reducing the threshold to what is available |
| A campaign whose targets lack access | Granting them access |
| A template that omits a mandated authority | Publishing it with a warning |
| A resolution date preceding submission | Accepting it as a data-entry quirk |
| A withdrawn version reaching its effective instant | Letting the scheduler win the race |
| A second replacement claiming an occupied scope | Publishing and sorting it out later |
| A pack that could not be fully assembled | Shipping it with sections missing |
| A cross-tenant identifier | Explaining that it exists but is forbidden |
| A second pre-release version for one variant | Allowing two candidates and resolving order later |

## The never-automatic register

Automation reminds, escalates, schedules and notifies. It never decides.

| Never automatic | Invariant |
|---|---|
| Approval, on any timeout or escalation | INV-APR-002 |
| Substituting an unavailable approver | INV-APR-005 |
| Acknowledging on someone's behalf | INV-ATT-007 |
| Invalidating an effective version because a review is late | INV-REV-001 |
| Resurrecting a superseded version when its successor is withdrawn | INV-EFF-004 |
| Merging, translating or overwriting a derived variant | INV-APL-007 |
| Clearing an alignment obligation | INV-APL-008 |
| Rewriting a mandated authority when the Governing Framework changes | INV-DOC-030 |
| Granting access as a side effect of applicability or campaign targeting | INV-AUTH-005, INV-AUTH-006 |
| Retiring a document because a review recommended it | — `review-model.md` |
| Classifying materiality | INV-VER-014 |

## Destruction

The product destroys almost nothing, and never as a convenience.

| Action | Available |
|---|---|
| Delete a Document | No, while governed records or evidence reference it. Retirement is the mechanism |
| Delete a released version | No. Withdrawal is the mechanism |
| Delete an audit event | No, through any application surface |
| Delete an approval decision or attestation response | No. Compensating events and appended corrections |
| Delete a user | No, while any record attributes an action to them. Deactivation, and pseudonymisation where erasure obligations require it |
| Delete a legal entity or org unit | No, while referenced. Inactivation |
| Dispose of records under a retention rule | Yes, per the customer's configured schedule, unless a legal hold is in force |
| Pseudonymise an identity | Yes, preserving governance chronology and record linkage |
