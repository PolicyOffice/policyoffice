# Glossary

Canonical vocabulary. These terms are **ubiquitous language**: they are used identically
in the specification, the database, the API, test names and the user interface. If a term
here changes, it changes everywhere in the same pull request.

Where a term differs from the source research blueprints, the change is noted and its
rationale is recorded in `docs/domain/consolidation-notes.md`.

## Naming decision: `Document`, not `Policy`

The source blueprints named the central aggregate `Policy`. Real customer taxonomies use
"Policy" as the name of a **document type**, alongside Procedure, Manual, Standard,
Guideline and others. Keeping `Policy` as the aggregate produces nonsense in code and UI:
`Policy(type = MANUAL)`.

The aggregate is therefore **`Document`**, and the type is a tenant-configurable
`DocumentType`. The product, its category and its marketing remain *policy operations* —
buyers search for policy management, and the product is not a document repository. The
change is to the domain vocabulary only.

## Organisation and identity

| Term | Meaning |
|---|---|
| **Tenant** | One customer organisation. The hard security and data-isolation boundary. No object, identifier, role or support capability crosses it. |
| **Legal Entity** | A company, subsidiary or branch inside the tenant. Forms a tree. Answers *which company is governed*. |
| **Org Unit** | Department, function or team. Answers *which organisational population is involved*. Separate from Legal Entity. |
| **Jurisdiction** | Legal or regulatory geography. Answers *which legal context applies*. Independent of Legal Entity: an entity registered in Lithuania may employ someone operating under Finnish rules. |
| **User** | A human principal within one tenant. |
| **Group** | A managed set of users, locally maintained or synchronised from an identity provider. |
| **Org Membership** | A user's dated assignment to a legal entity and org unit. Historical memberships are retained, because point-in-time questions depend on them. |
| **Governance Body** | A collective decision-making authority: Management Board, Supervisory Board, Audit Committee, AML Committee. Configurable per tenant. Can hold approval authority **as a body**, distinct from any of its members acting individually. |
| **Body Membership** | A user's dated seat on a Governance Body, optionally with a role such as chair or secretary. |

## Document taxonomy

| Term | Meaning |
|---|---|
| **Document** | The permanent logical identity of one governed instrument — "Information Security Policy". Survives every revision. Never itself carries content. |
| **Document Type** | Tenant-configurable classification: Policy, Procedure, Manual, Standard, Charter, Instruction. Carries a rank, a mandated approval authority and default review cadence. See `document-taxonomy.md`. |
| **Type Rank** | Ordered precedence within a tenant's taxonomy — for example Policy above Procedure above Manual. A lower-ranked document may not contradict a higher-ranked one. |
| **Governing Framework** | The document that prescribes how other documents are approved, reviewed and classified — the organisation's internal constitution. Typically named Internal Regulations, Statutes or Rules of Procedure. |
| **Mandated Authority** | The minimum approval authority a Document Type requires, derived from the Governing Framework. A workflow may add approvers beyond it; it may never require fewer. |
| **Document Variant** | A scoped expression of one Document: `BASELINE`, `REPLACEMENT`, `SUPPLEMENT` or `TRANSLATION`. |
| **Document Version** | An immutable released revision of one Variant — "v3.0, effective 1 October 2026". Everything evidence-critical resolves to a Version, never to a Document. |
| **Content Revision** | An editable pre-release snapshot of content. Many revisions may precede one released Version. Submission freezes exactly one. |
| **Content Digest** | Cryptographic hash over the canonicalised content and its governed attachments. What an approver actually approved. |

## Lifecycle and governance

| Term | Meaning |
|---|---|
| **Published** | Approved and visible to those permitted to see it. **Not** yet normative. |
| **Effective** | Currently normative for a resolved scope. The answer to *what applies now*. |
| **Superseded** | Was effective; a replacement has atomically taken over. |
| **Withdrawn** | Removed from effect by deliberate governance action. Never causes an older version to silently become effective again. |
| **Materiality** | Human classification of a change: `EDITORIAL`, `NON_MATERIAL`, `MATERIAL`, `EMERGENCY`. Drives approval depth and re-attestation. The system assists; it never decides legal materiality. |
| **Applicability** | Structured rule determining *whom a document governs*. Distinct from access. |
| **Access** | Whether a principal may see or act on a resource. Distinct from applicability. |
| **Attestation** | Whether a principal must explicitly acknowledge a specific Document Version. A third concept, distinct from both access and applicability. |

## Workflow

| Term | Meaning |
|---|---|
| **Workflow Template** | Stable identity of an approval definition. |
| **Workflow Template Version** | Immutable snapshot of stages and decision rules. Running approvals stay bound to the snapshot they started under. |
| **Approval Run** | One approval process against exactly one submitted Content Revision. |
| **Stage** | An ordered step within a run. Stages execute serially; tasks within a stage may run in parallel. |
| **Completion Rule** | `ALL`, `ANY_ONE`, `AT_LEAST_N`, or `BODY_RESOLUTION`. |
| **Approval Task** | One participant's obligation within a stage. The participant may be a user, a role at a scope, a group, or a Governance Body. |
| **Approval Decision** | An immutable recorded decision bound to an exact Content Revision and its digest. Corrections create new events; they never overwrite. |
| **Body Resolution** | An approval decision made by a Governance Body acting collectively, recorded with a resolution reference (minutes or protocol number), the resolution date, and the authorised person who entered it on the body's behalf. |
| **Reviewer** | Evaluates a candidate and may request changes. Cannot satisfy an approval requirement. |
| **Approver** | A participant whose recorded decision satisfies an approval requirement. |
| **Separation of Duties** | Configurable rule preventing, for example, an author from being the sole final approver. |

## Review, distribution and evidence

| Term | Meaning |
|---|---|
| **Review Rule** | Recurring or event-triggered requirement to reconsider a document. |
| **Review Case** | One actual scheduled or triggered review, with an outcome: `NO_CHANGE`, `CHANGE_REQUIRED`, `SCOPE_CHANGE_REQUIRED`, `RETIREMENT_RECOMMENDED`. |
| **Attestation Campaign** | Distribution effort binding one exact Document Version to an audience and a deadline. |
| **Attestation Assignment** | One principal's obligation within a campaign, retaining why they were targeted. |
| **Attestation Response** | Recorded acknowledgement, referencing the exact Version, its digest and the statement wording presented. |
| **Waiver** | A formally approved, time-bound deviation from a requirement, with rationale, owner, expiry and compensating controls. Many organisations call this a *policy exception*; the interface uses the tenant's configured label. Commercial V1. |
| **Audit Event** | Append-only record of a governance-relevant action. Points at governed records; never contains document bodies. |
| **Evidence Pack** | Deterministic point-in-time artefact assembled from authoritative records, with a manifest and integrity digests. Not a printed page. |
| **Retention Rule** | Configurable disposal schedule per record class. |
| **Legal Hold** | Authorised suspension of disposal. Grants no visibility of any kind. |

## Terms deliberately not used

| Avoid | Because |
|---|---|
| *Folder*, *page*, *space tree* as a source of authority | Organisation of the estate never determines obligation or permission |
| *Current* without qualification | Say **Effective** — "current" blurs published, effective and latest-drafted |
| *Latest version* in any governance context | Everything evidence-critical binds to an exact Version |
| *Sign* / *signature* for attestations | An acknowledgement is not a qualified electronic signature. Use **acknowledge**. |
| *Immutable* for the audit log without qualification | It is append-only through the application contract. Cryptographic tamper-evidence is a separate, later claim. |
