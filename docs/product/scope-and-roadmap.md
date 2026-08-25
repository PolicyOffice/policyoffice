# Scope and Roadmap

Three releases, each with a thesis. Acceptance criteria here are written to be testable —
if a criterion cannot become a failing test, it is a wish and it does not belong.

| Release | Thesis |
|---|---|
| **Pilot** | Prove the entire controlled loop, end to end, with real users and real evidence |
| **Commercial V1** | Add the enterprise layer that procurement, identity and multi-entity operations require |
| **Later** | Regulatory intelligence, control mapping and carefully bounded AI, on top of records that are already trustworthy |

## The golden slice

The Pilot is not "a few CRUD screens". It is the smallest product that proves the whole
chain:

```text
create document → draft revision → submit immutable candidate → request changes →
resubmit → approve → publish → become effective → assign audience → acknowledge →
inspect audit history → complete a scheduled review → generate an evidence pack
```

**Pilot exit criterion.** A demonstration performs that entire flow with at least three
distinct principals — author, approver, reader — and then generates an evidence pack that
reconstructs what happened, with no database manipulation at any point.

That last clause is the real bar. Any product can demonstrate a happy path; the question
is whether the records left behind can be assembled into proof by the system itself.

## Pilot

| Epic | Scope | Acceptance criteria |
|---|---|---|
| **Tenant and organisational foundation** | Tenant, users, groups, org units, one seeded legal entity, statuses | A user in tenant A cannot read, mutate or detect any resource of tenant B through UI, API, search or a guessed identifier, and the response is indistinguishable from a genuinely absent resource (INV-TEN-001, INV-TEN-002, INV-TEN-005). Deactivating a user revokes sessions and blocks new governed actions while leaving historical attribution intact (INV-AUTH-014). An org unit with references cannot be deleted, only deactivated (INV-ORG-003) |
| **Document register** | `Document`, `DocumentType`, ownership, register metadata, search and filter | A document can be created with a code unique in the tenant, a type and an owner, and can exist before any version is effective. An unowned document is visible as a governance exception (INV-DOC-006). Filters never reveal documents the requester cannot access, including through counts and facets (INV-AUTH-012). Type is taken from `document_type_id`, never parsed from the title (INV-DOC-005) |
| **Drafting and immutable versions** | `DocumentVersion`, `ContentRevision`, digests, comparison against the effective version | Ten draft saves produce ten content revisions and no released versions (INV-VER-001). Submission freezes exactly one revision with its digest and attachments (INV-VER-002). No code path mutates the content of an approved or later version (INV-VER-003). A second pre-release version for the same variant is refused (INV-VER-012). Every attachment participates in the digest (INV-VER-013) |
| **Controlled approval** | Runs bound to a template version, serial stages, approve / request changes / reject, body resolutions | The approver sees the exact submitted revision and its digest. Content cannot be edited while a run is active (INV-VER-004). Requesting changes terminates the run and returns work to drafting (INV-APR-003); resubmission opens a fresh run and prior decisions never carry over (INV-APR-004). No elapsed time produces an approval (INV-APR-002). A body resolution names the body as approver and the recorder separately (INV-APR-021), requires capability for that body (INV-APR-023), and cannot carry a resolution date earlier than submission (INV-APR-022). A workflow omitting the type's mandated authority cannot start a run (INV-APR-020) |
| **Publication and effectivity** | Approved, published, future-effective, superseded, withdrawn | A published version before its effective instant is visible and not normative (INV-EFF-001). At the effective instant the successor becomes effective and the predecessor's interval closes in one transaction (INV-EFF-003). A scheduler firing twice produces one event (INV-EFF-007). A version withdrawn before its instant never becomes effective, including under a race (INV-EFF-008). Withdrawal never resurrects a predecessor (INV-EFF-004) and, where nothing else is effective, emits `governance.policy_gap` (INV-EFF-005) |
| **Scoped access control** | Roles, grants, explicit deny, time-bounded grants | Default deny (INV-AUTH-001). A grant at an ancestor scope reaches contained documents; a document-scope grant exposes only that document and never its ancestors (INV-AUTH-008). An explicit deny defeats any allow regardless of specificity (INV-AUTH-002). A grant past `valid_until` stops authorising at the next check, with no cleanup job involved (INV-AUTH-003). Every grant, revocation and denial-of-sensitive-resource is audited |
| **Review scheduling** | Rules, cases, reminders, escalation, four outcomes | A case is created on schedule and exactly one is open per rule (INV-REV-006). `NO_CHANGE` completes the review with a rationale and creates no version (INV-REV-003). An overdue review leaves the effective version untouched and raises a visible exception (INV-REV-001, INV-REV-002). Completion schedules the next occurrence deterministically, including across month-end and DST (INV-REV-004, INV-TIME-002). A completed case names the exact version reviewed (INV-REV-007) |
| **Attestation campaigns** | Snapshot audiences, assignments, statements, reminders, completion | A campaign binds one exact version (INV-ATT-001). Launch is refused where any target lacks access, and nobody is granted access to resolve it (INV-AUTH-007). Each principal receives exactly one assignment, retaining why they were targeted (INV-ATT-004, INV-ATT-012). A response records version, digest, statement version, locale, responder and instant (INV-ATT-002). A response after the deadline is `COMPLETED_LATE` permanently, and a later deadline extension does not rewrite it (INV-ATT-003, INV-ATT-011). Duplicate notification delivery produces no duplicate obligation (INV-ATT-010) |
| **Audit ledger** | Canonical envelope, the MVP event catalogue, an explorer | Every governance transition emits exactly one canonical event (INV-AUD-001) carrying tenant, actor, subject, UTC instant, outcome, correlation and configuration version (INV-AUD-005, INV-CFG-003). No application surface can update or delete an event (INV-AUD-002). No event contains document bodies or unnecessary personal data (INV-AUD-003). Events order deterministically within a tenant (INV-AUD-009) |
| **Evidence packs** | Document and version packs, manifest, integrity | A pack contains a manifest with schema version, instants, requester, included objects and per-file digests (INV-EVD-002), and every file validates against its digest using a hash utility alone (INV-EVD-003). A partially assembled pack is marked failed and never offered as complete (INV-EVD-004). Request, generation, failure and download each emit events (INV-EVD-005). A pack never includes records the requester could not read (INV-EVD-010) |
| **Search** | Full-text and metadata search over authorised, effective content | Default results are effective content the requester may access. Historical and pre-release results require an explicit mode and permission. Authorization is enforced at retrieval, so a stale index leaks nothing (INV-AUTH-011). A historical result is labelled unmistakably as historical |
| **Governance dashboard** | Overdue approvals and reviews, incomplete campaigns, unowned documents, policy gaps | Every count reconciles exactly against source records, and every tile drills through to the rows behind it |
| **Notifications** | Email and in-app reminders and escalations | Messages are queued from domain events. Retries create no duplicate assignment or transition (INV-TIME-004). Delivery failure is observable and never alters governance state. Sensitive content is not embedded in email |

### Deliberately out of the Pilot

| Not in the Pilot | Because |
|---|---|
| Variants — replacement, supplement, translation | The Pilot has one legal entity. The resolver has nothing to resolve, and the concepts are already in the schema |
| Waivers | An adjacent workflow. Modelled from the start so the schema is not retrofitted |
| SSO and SCIM | Local users and groups prove the loop. Enterprise identity is a procurement requirement, not a governance one |
| Retention and legal hold | Nothing is old enough to dispose of. Record classes are assigned from day one |
| Public API and webhooks | Internal contracts are designed; the public surface waits for someone to integrate |
| Template editing UI | Templates exist and runs bind to them. Whether customers can edit them is open decision 4 |
| Dynamic attestation audiences | Snapshot audiences produce evidence that explains itself |
| Break-glass elevation | No production customer data to break glass into yet |

## Commercial V1

| Epic | Scope | Acceptance criteria |
|---|---|---|
| **Enterprise identity** | OIDC and SAML SSO, SCIM users and groups, SSO enforcement, break-glass | A user deprovisioned at the IdP loses sessions and access without manual action, while historical evidence is untouched. Group changes propagate without altering completed runs or snapshot campaigns (INV-APR-012, INV-ATT-006). An SSO outage has a documented, audited administrative recovery path. Break-glass requires reason and expiry, and tags every event it produces (INV-AUTH-013, INV-AUD-006) |
| **Configurable workflows** | Template editing and versioning, parallel tasks, all four completion rules, delegation, escalation, separation of duties | Editing a template creates a new version and alters no active or historical run (INV-APR-010). A stage that can no longer be satisfied blocks and raises an exception rather than lowering its threshold (INV-APR-013). Delegation moves a task and never a capability (INV-APR-014). Where configured, the author cannot be the sole final approver (INV-APR-011). Escalation never approves (INV-APR-002) |
| **Legal entities and jurisdictions** | Entity hierarchy, dated memberships, jurisdiction dimension, historical scope | Applicable scope resolves from memberships valid at the requested instant (INV-APL-009). A closed entity preserves historical resolution (INV-ORG-003). A jurisdiction differing from an entity's country of registration resolves correctly (INV-ORG-004) |
| **Variants and conflict resolution** | Baseline, replacement, supplement; the specificity ladder | An exact-scope replacement wins over the baseline; supplements coexist with whatever resolved (INV-APL-005). Two equal-specificity replacements block publication with a named collision (INV-APL-003), and if one ever reaches the reader path, resolution fails closed with an alert (INV-APL-004). A `MANDATORY` scope refuses a descendant replacement (INV-APL-012). Resolution explains why each variant applied |
| **Localisation** | Translations, alignment obligations | A translation names its source version and never alters legal scope (INV-APL-006). Publishing upstream marks derived variants alignment-required without merging, translating or overwriting anything (INV-APL-007). The status cannot be cleared except by a recorded governance action (INV-APL-008) |
| **Advanced access** | Access requests, temporary grants, external auditor role, sensitive documents | An approved temporary grant expires with no manual action and no job dependency. An open session cannot continue retrieving after expiry (INV-AUTH-004). The auditor role holds no capability that mutates a governed record |
| **Dynamic attestation** | Enrolment windows, material-change targeting, exemptions | A qualifying joiner receives an assignment inside the enrolment window. A material change targets only the affected audience (INV-ATT-009). An exemption records authority, reason and expiry. Departure cancels future obligations without deleting completed responses (INV-ATT-005) |
| **Retention and legal hold** | Record classes, disposal, holds | Eligible records are disposed under the configured schedule; a held record is not (INV-RET-001). Release resumes evaluation and destroys nothing immediately (INV-RET-002). Pseudonymisation preserves chronology and linkage (INV-RET-004). No period is presented as legally required (INV-RET-003) |
| **Advanced evidence** | Point-in-time packs, privacy profiles, determinism | An as-of request resolves the version, memberships and audience in force at that instant (INV-EVD-007). Regeneration yields the same substantive records (INV-EVD-006). The minimal profile excludes individual-level personal data. Download links expire, enforced at retrieval (INV-EVD-008) |
| **Waivers** | Request, approval, expiry, revocation, revalidation | A waiver requires scope, owner, rationale, compensating controls and an expiry. Expiry produces a remediation task. It never alters document content, and supersession of the referenced version triggers revalidation rather than silent transfer |
| **API, webhooks and migration** | Content and reporting API, webhooks, bulk import and export | API authorization is identical to UI authorization (INV-AUTH-010). Webhook retries are idempotent. Import is resumable and produces no duplicates on retry (INV-TIME-004). Customers can export their governed records in durable formats without vendor assistance |
| **Reporting** | Ownership, review, workflow, attestation and alignment reports | Every aggregate traces to source records. A historical report uses the population and state of that period, not today's |

## Later

Each of these has a bar to clear before it is production-ready. The bar is the point.

| Capability | Bar |
|---|---|
| **AI change summaries and semantic diff** | The summary always names source and target versions; the deterministic diff underneath is always available; a hallucinated summary cannot affect approval state or materiality |
| **Regulatory change intake** | Every signal carries provenance; suggested impacts remain proposals until a human disposes of them; nothing normative changes automatically |
| **Document-to-control and regulation mapping** | Relationships are versioned and audited; evidence can show which version supported a control on a given date |
| **Estate conformance checking** | The deterministic half first — does every workflow and historical approval actually satisfy the mandated authority. The language-understanding half stays advisory and human-confirmed |
| **Permission-aware question answering** | Retrieval cannot surface content the asker cannot read, demonstrated by an automated red-team suite covering cross-tenant and restricted-document isolation. Where the asker is a machine acting for a person, authority is the intersection of both (INV-AUTH-018) |
| **Cryptographic provenance** | An independent verifier detects modified files and validates provenance without the application |
| **Customer-managed keys, sovereign deployment** | Threat model, backup, rotation, DR and support procedures demonstrated end to end before any sale |
| **Offline reading** | The client marks stale cached content, honours expiry, and synchronises acknowledgements without duplicate evidence |

AI comes late on purpose. The first competitive obligation is not to have a chatbot; it is
to make the underlying records trustworthy enough that AI can operate on them without
inventing the state of the organisation.

Nothing above schedules a machine-facing interface. `docs/architecture/machine-access.md`
records the constraints that keep one buildable as an adapter rather than a rewrite, and is
explicitly not a commitment to build it.

## Release gates

| Gate | Additionally requires |
|---|---|
| **Golden slice** | The reference flow runs end to end through the interface and in tests |
| **Private alpha** | Tenant-isolation suite, review workflow, audit completeness, authorised search, evidence generation |
| **Design-partner pilot** | Operational monitoring, a rehearsed backup and restore, migration tooling sufficient for a real estate, support procedures, and documented known limitations |
| **Commercial V1** | Whichever identity, retention, multi-entity, privacy and procurement capabilities the first customers actually require. Not "SAML exists and there is a legal-hold button" |

## Dependencies on open decisions

| Decision | Affects | Status |
|---|---|---|
| 1 — Pilot `LegalEntity` capability | The first migration | **Decided** — schema-complete, behaviour-minimal. The Pilot seeds one entity per tenant |
| 2 — Authoring model | Drafting, comparison, materiality warnings, rendering | **Decided** — file-centric. Drafting means uploading a controlled file; comparison and warnings run over extracted text |
| 7 — Data residency | Every infrastructure choice | **Decided** — one EU region, complete |
| 3 — `Space` semantics | Register navigation only | Open |
| 4 — Workflow configurability | Whether the Pilot ships a template editor | Open |
| 5 — Applicability complexity | Campaign audience and register filtering in the Pilot | Open |

The three that blocked architecture were answered on 2026-08-24 and the Pilot scope above
reflects them. The Pilot scope for the remaining three assumes their stated recommendation
in `docs/plans/open-decisions.md`; where the founder decides otherwise, this chapter
changes with it — the invariants do not.
