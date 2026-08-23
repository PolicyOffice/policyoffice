# Consolidation Notes

How two overlapping research blueprints and founder domain input became one canonical
specification. This file records **where the sources disagreed and which won**, so that a
later reader does not have to re-derive it.

## Sources and precedence

| Source | Role |
|---|---|
| **Master Product Blueprint v0.1** (47 pp) | Primary authority on domain semantics, lifecycle, versioning, attestation, evidence and Pilot scope |
| **Product & Domain Blueprint** (38 pp) | Secondary. Authority on Space, waivers, API shape, ADR backlog, CI and delivery design |
| **Strategic market research** | Positioning, ICP, pricing, competitive framing. Not a domain authority. |
| **Founder domain input** (2026-08-24) | Primary authority on real-world governance structure — document taxonomy, approval authority, collective bodies |

Rule: where the two blueprints conflict on **domain semantics**, the Master Blueprint
wins. Where they conflict on **engineering or delivery**, the secondary blueprint is
usually more concrete and wins. Founder domain input outranks both on how organisations
actually govern documents, because it is primary evidence rather than synthesis.

## Contradictions resolved

| # | Question | Master (47 pp) | Secondary (38 pp) | Resolution |
|---|---|---|---|---|
| 1 | How is a variant modelled? | `PolicyVariant` as a child of Policy | A separate `Policy` linked by `parent_policy_id` | **Master.** `Document → DocumentVariant → DocumentVersion → ContentRevision`. A variant that is its own top-level document loses the shared identity that makes cross-border resolution possible. |
| 2 | Are draft saves versions? | Explicit `ContentRevision` entity | Draft is mutable, then sealed; no revision entity | **Master.** Keep `ContentRevision`. Without it, "request changes → revise → resubmit" either manufactures fake released versions or loses the drafting trail. |
| 3 | Is `Space` a concept? | Absent | First-class | **Secondary.** Kept, with strict semantics: a Space organises administration only. Space is never applicability, never authorization, never legal entity. |
| 4 | `Published` or `Scheduled`? | `Approved → Published → Effective` | `Approved → Scheduled → Effective` | **Neither as a state pair.** `Published` is a state (visible but not normative). *Scheduled* is not a state — it is the derived condition `effective_at > now`. Modelling it as a state duplicates information already in the timestamp and creates an extra transition to get wrong. |
| 5 | `ChangesRequested` or `Rejected`? | `ChangesRequested → Draft` | `Rejected → revise → Draft` | **Both, as distinct outcomes.** *Request changes* is iterative and returns to drafting. *Reject* terminates the candidate; a new candidate must be started deliberately. Collapsing them loses a real governance distinction. |
| 6 | Are waivers/exceptions in the Pilot? | V1, priority P2 | P0, "basic" in MVP | **V1.** The Pilot must prove the governance loop end to end; waivers are an adjacent workflow. Modelled in the domain from the start so the schema does not have to be retrofitted. |
| 7 | Attestation states | 8 states incl. `COMPLETED_LATE`, `CANCELLED_DEPARTURE` | 6 states incl. `DECLINED` | **Master's set, plus `DECLINED`.** A principal refusing to acknowledge is a real and important governance fact, not an absence of response. |
| 8 | Materiality classes | Editorial, Minor, Material, Emergency | EDITORIAL, NON_MATERIAL, MATERIAL | **`EDITORIAL`, `NON_MATERIAL`, `MATERIAL`, `EMERGENCY`.** Master's "Minor" and Secondary's "NON_MATERIAL" are the same class; the latter name states the governance consequence rather than the size. |
| 9 | Review outcomes | 4 outcomes | 2 outcomes | **Master.** `NO_CHANGE`, `CHANGE_REQUIRED`, `SCOPE_CHANGE_REQUIRED`, `RETIREMENT_RECOMMENDED`. |
| 10 | `OrgUnit` or `Department`? | `OrgUnit` | `Department` | **`OrgUnit`.** A department is one kind of org unit; teams, functions and divisions are others. |
| 11 | Completion rules | `ALL`, `ANY_ONE`, `AT_LEAST_N` | `ALL`, `ANY`, `N_OF_M` | **Master's names**, plus `BODY_RESOLUTION` added from founder input. |
| 12 | When does `LegalEntity` arrive? | V1 | P0 / MVP | **Split.** The entity exists in the MVP schema with a single default entity per tenant. Hierarchy, dated memberships and inheritance-based resolution are V1. Deferring the *concept* would force a painful migration; building the *resolution engine* now would delay the golden slice. Recorded as an open decision for confirmation. |
| 13 | Audit event naming | `policy.created` | `POLICY_CREATED` | **Lowercase dotted**, e.g. `document.created`, `version.approved`. Reads better in filters and is the more common convention for event catalogues. |
| 14 | Evidence pack layout | Structured subdirectories | Flat with more CSVs | **Master's structure**, plus the secondary's `access-history.csv` and `exceptions.csv` where those features exist. |

Both blueprints agreed, and the agreement is recorded as canonical, on: published ≠
effective; released content is immutable; approval binds an exact revision; overdue review
never invalidates an effective document; ambiguity fails closed; attestation binds an
exact version; assignment never grants access; no timeout ever auto-approves; audit is
append-only with compensating corrections; evidence is generated from source records.

## Additions from founder domain input

Neither blueprint modelled these. All four come from how a European payment institution
actually governs its documents.

| Addition | Why it was missing | Where specified |
|---|---|---|
| **Ranked `DocumentType` taxonomy** — Policy above Procedure above Manual, tenant-configurable | Both sources assumed a flat type carrying a default workflow, which cannot express that a Manual may not contradict a Policy | `document-taxonomy.md` |
| **`GovernanceBody` and `BODY_RESOLUTION`** — approval by a collective body | Both sources modelled approvers as users, roles or groups. "The Management Board resolved" is a different governance fact from "five people clicked approve", and European corporate governance runs on the former | `document-taxonomy.md`, INV-APR-021…023 |
| **`GoverningFramework`** — the internal constitution that prescribes approval rules for every other type | Both sources treated workflow configuration as free-standing. In reality it derives from a document, and that provenance is what makes it auditable | `document-taxonomy.md`, INV-DOC-030 |
| **Type-versus-title drift** — a document titled "SCA Guidelines v2" that is, in the taxonomy, a Manual | Both sources assumed clean metadata. Real estates arrive messy, and the product's job is to surface the mess without refusing the import | `document-taxonomy.md`, INV-DOC-005 |
| **The configurable / invariant boundary, and governance profiles** | Both sources described governance rules as though one correct model existed. In reality a small fintech wanting version tracking and review reminders and a bank wanting board resolutions with minutes are the same product under different configuration. Neither source drew the line between what a customer may configure and what the product guarantees regardless | `configuration-model.md`, INV-CFG-001…006 |

## Deliberate departures from both sources

| Departure | Rationale |
|---|---|
| Aggregate renamed `Policy` → **`Document`** | Customer taxonomies use "Policy" as a *type*. `Policy(type = MANUAL)` is nonsense in code and in the interface. Product positioning and category naming are unaffected. |
| `Scheduled` is a derived condition, not a lifecycle state | See contradiction 4. Fewer states, no duplicated truth. |
| No per-PR preview environments in the Pilot | Playwright runs against the application inside the CI runner with a Postgres service container: full coverage, no infrastructure, €0. Preview deployments arrive when there is a design partner to show. |
| `PolicyException` renamed **`Waiver`** | `PolicyException` reads as an error class in every mainstream language. The interface still shows the tenant's own label, commonly "policy exception". |

## Left open

These require a decision before the physical data model is frozen. They are tracked in
`docs/plans/open-decisions.md`, not resolved here.

1. How much `LegalEntity` capability belongs in the Pilot (contradiction 12 above).
2. Native editor versus file/Office-centric authoring, and therefore the canonical content
   representation and what participates in hashing.
3. Final `Space` semantics — one Space per document, or many.
4. Whether the Pilot ships a single fixed approval workflow or configurable templates.
5. Pilot applicability complexity — explicit audience lists only, or rule-based.
