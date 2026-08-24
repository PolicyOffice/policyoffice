# Open Decisions

Questions that need the founder, not an agent.

Each entry states the context, the real options, a recommendation, what follows from
choosing it, and how expensive it is to change later. The recommendation exists so that
answering is a matter of agreeing or disagreeing rather than starting from a blank page.

**How this file is used.** When a decision is made, record the answer and the date under
the entry, move it to [Decided](#decided), and update the affected specification chapters
in the same pull request. Until then, agents proceed under the stated recommendation where
work can continue, and stop where it cannot — the *Blocks* line says which.

Nothing here is decided by an agent. Nothing here stalls unrelated work either.

## Summary

| # | Decision | Blocks | Answer, or recommendation | Status |
|---:|---|---|---|---|
| 1 | Pilot `LegalEntity` capability | First migration, physical model | Schema-complete, behaviour-minimal | **Decided 2026-08-24** |
| 2 | Authoring model and canonical content | Content storage, hashing, diff, editor | File-centric for the Pilot | **Decided 2026-08-24** |
| 3 | `Space` semantics | Register navigation | One Space per tenant in the Pilot | Open — does not block |
| 4 | Pilot workflow configurability | Approval implementation, admin scope | Template-backed, not customer-editable | Open — does not block |
| 5 | Pilot applicability complexity | Campaign audience, register filters | Explicit audience lists | Open — does not block |
| 6 | Licence | Publishing the repository | PolyForm Shield 1.0.0 | **Decided 2026-08-24** |
| 7 | Data residency and region | ADR-000 and every infrastructure ADR | One EU region, stated completely | **Decided 2026-08-24** |
| 8 | Product and repository name | Publishing the repository, and CI on the free tier | A name only the founder can choose | **Open — now blocks Phase 2** |
| 9 | Human-readable rendering in evidence packs | One line of the pack layout | Ship originals in the Pilot; amend the layout | Open — does not block |

Decisions 1, 2, 6 and 7 are answered. Phase 1 has begun. **Decision 8 — the product and
repository name — now blocks Phase 2**, because CI on the free tier assumes a public
repository and a public repository needs a licence file naming a licensor and a product.
Decisions 3, 4 and 5 shape Pilot scope and stop nothing.

---

## 1 — How much `LegalEntity` capability belongs in the Pilot

> **Decided 2026-08-24 — option A, schema-complete and behaviour-minimal.** Founder.

**Context.** The two blueprints disagreed: one placed legal entities in Commercial V1, the
other in the MVP. `consolidation-notes.md` contradiction 12 split the difference and
marked it for confirmation. The question is not whether the product needs entities — it
does — but how much of the machinery the Pilot carries.

| Option | What it means | Consequence |
|---|---|---|
| **A. Schema-complete, behaviour-minimal** | `LegalEntity`, `OrgUnit` and `OrgMembership` exist from the first migration. Exactly one entity is seeded per tenant. The resolver does no hierarchy traversal | Pilot behaviour is simple. No governance table gains a dimension later |
| **B. Full hierarchy in the Pilot** | Entity tree, dated memberships, ancestor resolution, entity-scoped grants, all exercised | Weeks of work the Pilot cannot demonstrate with one design partner, and a much larger test surface |
| **C. Defer entirely** | No entity concept until V1 | Adding a tenant → entity dimension to twenty tables afterwards touches every query, every grant and every test |

**Recommendation: A.** The cost of carrying an unused column is one column. The cost of
retrofitting an entity dimension through a governance model that already has effective
intervals, applicability and evidence is a rewrite, and it lands exactly when the first
multi-entity customer is being onboarded.

**Reversibility.** A → B is a data migration plus a resolver that walks a ladder it
already knows about. C → anything is the expensive path.

**Blocks.** The first migration and the physical data model. Phase 1 cannot start the
schema without this.

---

## 2 — Native editor versus file-centric authoring

> **Decided 2026-08-24 — option A, file-centric.** Founder.

**Context.** This determines the canonical content representation, and therefore what
participates in hashing, how diffs are produced, what a rendering is derived from, and
what "editing" means in the interface. `versioning.md` specifies the manifest contract in
a way that survives either answer, but nothing below that line can be built without one.

| Option | What it means | Consequence |
|---|---|---|
| **A. File-centric** | Customers upload the controlled file. The governed artefact is those bytes. Text is extracted for diff and for the deterministic materiality warnings | Matches how regulated European organisations actually author — in Word, with tracked changes and Legal's comments. Digests are honest and trivial. Diff quality depends on extraction. "Editing" means uploading a new revision |
| **B. Native structured editor** | Content is structured data the product owns | Excellent diffs, clean rendering, real authoring UX. It is also a large build competing with Word, and the master blueprint's own advice is not to try to beat Microsoft at general-purpose authoring |
| **C. Both from the start** | Two content part types | Twice the surface, in the phase that can least afford it |

**Recommendation: A for the Pilot.** The manifest is already part-based, so a native
editor later adds a content part type rather than replacing the model. The Pilot's job is
to prove the governance loop, and the governance loop does not require owning the editor.

Worth being explicit about the cost: with file-centric content, the *quality* of the
materiality warnings depends on text extraction from `.docx`, which is good but not
perfect, and comparison against a PDF-only upload is weak. If the first design partner
authors policies as PDFs with no source document, that weakness will be visible.

**Reversibility.** Moderate. Additive if the manifest stays part-based from day one, which
the specification requires either way.

**Blocks.** Content storage, digest implementation, diff, the materiality warning rules,
and the entire authoring surface.

---

## 3 — Final `Space` semantics

**Context.** `Space` survived consolidation with deliberately narrow semantics: it
organises administration, and INV-AUTH-015 and INV-APL-010 forbid it from touching
authorization or applicability. What remains is a browsing and grouping concept, and the
question is how much of it the Pilot needs.

| Option | What it means | Consequence |
|---|---|---|
| **A. One Space per tenant in the Pilot** | The entity exists; the concept is effectively invisible. Many Spaces arrive in V1 | Nothing to design now, nothing to migrate later |
| **B. Many Spaces from the start** | Subject-area grouping — Information Security, HR, Finance — with default ownership | More register navigation to build and test, for a Pilot with perhaps forty documents |
| **C. Drop `Space` entirely** | Group the register by owning org unit | Simpler model. But subject grouping and ownership genuinely differ: three units contribute to Information Security, and a register organised by department does not reflect how people look for policies |

**Recommendation: A**, with C kept live. If the design partner's register turns out to
navigate naturally by owning unit, dropping Space removes an entity for free — and because
of INV-AUTH-015 and INV-APL-010, removing it can never change who is governed or who has
access. That property is what makes this decision cheap.

**Reversibility.** High in every direction.

**Blocks.** Register navigation design only. Not the data model's spine.

---

## 4 — Fixed workflow or configurable templates in the Pilot

**Context.** `approval-workflows.md` requires that runs bind to an immutable template
version and a frozen participant set (INV-APR-010, INV-APR-012). That is a structural
requirement. Whether customers can *edit* templates in the Pilot is a scope question.

| Option | What it means | Consequence |
|---|---|---|
| **A. Template-backed, not customer-editable** | Each governance profile seeds one or two template versions. Runs bind to them by identifier. No template editor ships | Full structural correctness with no admin UI. Changing a customer's workflow is a configuration change we make |
| **B. Full template editor in the Pilot** | Customers build their own stages | Significant UI work — stage ordering, participant resolution, completion rules, validation against mandated authority — for a Pilot with one or two customers |
| **C. Hard-coded workflow, no template entity** | Approval logic in code | Breaks INV-APR-010 and INV-APR-012 the moment the code changes, because historical runs have nothing to bind to. Every past approval silently acquires today's meaning |

**Recommendation: A.** C is the option to avoid — it is cheaper this month and makes every
historical approval uninterpretable the first time the workflow is edited.

**Reversibility.** A → B is purely additive. C → anything requires reconstructing what
each historical run actually ran under, which by then nobody knows.

**Blocks.** Approval implementation scope and seeding. Not the schema, which is the same
under A and B.

---

## 5 — Pilot applicability: explicit lists or rules

**Context.** `multi-entity-model.md` specifies a deterministic resolver with a specificity
ladder. With one legal entity and a baseline variant, most of that machinery has nothing
to resolve. The question is what the Pilot expresses applicability *with*.

| Option | What it means | Consequence |
|---|---|---|
| **A. Explicit audience** | Applicability names org units, groups or users directly | Trivially deterministic, easy to explain to the design partner, and the campaign audience is obvious. INV-APL-001 holds trivially |
| **B. Rule-based from the start** | Predicates over entity, org unit and jurisdiction | The full resolver, plus property-based tests, for a tenant with one entity |

**Recommendation: A.** The `ApplicabilityRule` entity already holds structural targets, so
moving from A to B is data and resolver work, not a schema change. Property-based testing
of the specificity ladder arrives with the capability it protects.

**Reversibility.** High.

**Blocks.** Campaign audience resolution and register filtering in the Pilot.

---

## 6 — Licence

> **Decided 2026-08-24 — option A, PolyForm Shield 1.0.0**, together with the decision to
> make the repository public. Founder.

**Context.** The repository is currently unlicensed, which means all rights reserved by
default. `README.md` already states the intended posture — *source-available: readable by
anyone, not re-sellable as a competing service* — so the open question is which instrument
implements it, not whether to be source-available.

| Option | What it means | Consequence |
|---|---|---|
| **A. PolyForm Shield 1.0.0** | Everything permitted except competing with us | Says what the README already says, in about a page. Short enough that an enterprise buyer's counsel will actually read it, and there is no date mechanic to explain |
| **B. BSL 1.1 with a change date** | Non-production use permitted; converts to an open licence after a fixed period | Familiar to developers. The change-date mechanics reliably generate procurement questions, and the usual four-year conversion is a commitment made now about a product that does not exist yet |
| **C. AGPL-3.0** | Copyleft | Many enterprise buyers have a standing policy against it, and it does not stop a competitor operating the service. Wrong instrument for this posture |
| **D. Stay unlicensed while private** | Status quo | Coherent today, and an obstacle the moment a design partner, a contractor or a public repository is involved |

**Recommendation: A.** PolyForm Shield is the closest available match to the posture the
README already commits to, and the easiest of these to defend in a procurement review.

This one is commercial rather than technical, and the recommendation carries less weight
than the others here.

**Reversibility.** Low in one direction: a licence granted on a published version cannot
be withdrawn from that version, so a later change binds only future versions. Adding a
licence where none exists is trivial.

**Blocks.** Making the repository public, outside contributions, giving a design partner
source access.

---

## 7 — Data residency and hosting region

> **Decided 2026-08-24 — option A, one EU region, stated completely.** Founder.

**Context.** EU hosting is a commercial posture rather than a GDPR requirement — the
transfer regime governs transfers, it does not mandate that all data stay in the EEA. But
the *commitment* is contractual, appears in every security review, and DORA-facing
customers need the countries of processing and storage stated. The specific region and
provider is a Phase 1 architecture and cost question; the commitment is not.

| Option | What it means | Consequence |
|---|---|---|
| **A. One EU region, complete** | Application data, object storage, backups, search indexes, audit storage, evidence packs, queues carrying payloads, DR replicas and observability containing customer data — all in-region | The strongest and simplest claim, and checkable. It constrains provider choice and rules out convenient non-EU managed services for logging and search |
| **B. EU region with disclosed exceptions** | One or two components outside, listed explicitly | Cheaper and more flexible. Every security review then spends its time on the exceptions |
| **C. Multi-region with customer choice** | Customers pick | Real operational complexity — migrations, per-region backups, per-region DR drills — for a product with no customers yet |

**Recommendation: A.** The competitive lesson from the larger vendors is that partial
residency claims are the ones that cost deals: Atlassian's documentation currently
excludes its organisation audit log from residency, and that single exclusion is the kind
of thing a CISO finds and asks about. A small vendor's credible differentiator is a
complete statement that lists exactly what is resident.

**Reversibility.** Low. Residency commitments end up in contracts and data-processing
agreements, and narrowing one afterwards is a renegotiation.

**Blocks.** ADR-000 stack selection and every infrastructure ADR that follows.

---

## 8 — Product and repository name

> **Now blocking.** The repository is going public (decided 2026-08-24), which the CI gate
> list depends on for unlimited Actions minutes. The licence file needs a licensor and the
> repository needs a name before that can happen.

**Context.** `README.md` carries *Policy Operations Platform* as a working name and flags
naming as open. Nothing technical depends on it, but it appears in the licence file, the
repository URL, every customer-facing artefact and — once chosen — in package names that
are tedious to change.

| Option | What it means | Consequence |
|---|---|---|
| **A. Decide before the repository goes public** | The name is chosen alongside the licence | One rename, before anything external references it |
| **B. Keep the working name through the Pilot** | Rename after design-partner feedback | The design partner sees a working name, and the rename later touches package names, URLs and any signed artefacts |

**Recommendation: A**, coupled with decision 6. The two land together — a public
repository needs both — and renaming after a design partner has bookmarked, linked and
referenced the product is the expensive ordering.

There is no recommendation on *which* name. That is a founder decision, and the only input
worth recording is a practical one: check the `.eu` and `.com` domains and the npm scope
before committing, because the package name follows the repository name.

**Reversibility.** High before publication. Moderate afterwards, and it degrades steadily.

**Blocks.** Phase 2 — repository bootstrap. CI on the free tier assumes a public
repository, and a public repository needs a licence file naming a licensor and a product.

---

## 9 — Human-readable rendering in evidence packs

> **Raised by `ADR-0008`, 2026-08-24.** An architecture decision would have quietly
> narrowed a specified deliverable, so it is escalated instead — the rule in `AGENTS.md`
> working as intended.

**Context.** `evidence-model.md` specifies that a pack contains `document/document.pdf`, a
human-readable rendering, alongside `document/original/`. With file-centric content
(decision 2) that is free when the controlled file is already a PDF, and expensive
otherwise: converting `.docx` faithfully needs LibreOffice or an equivalent in the
deployment, which is real operational weight and, on any managed platform, real money.

| Option | What it means | Consequence |
|---|---|---|
| **A. Originals only in the Pilot** | `document.pdf` is present when the controlled file is already a PDF; otherwise the manifest records it as absent with a reason. `evidence-model.md`'s layout is amended to say so | Costs nothing, ships now, and the pack is honest about what it contains. A recipient expecting a rendering gets the original instead, which is the authoritative artefact anyway |
| **B. A converter in the deployment** | LibreOffice or equivalent in a container | Faithful renderings for everything. Significant memory and cold-start weight, a large attack surface parsing untrusted documents, and it almost certainly needs a paid host |
| **C. A conversion API** | A third-party service | Least operational work, and it adds a subprocessor, a cost, and a residency question against decision 7 — customer document content would leave our region |
| **D. Require PDFs as the controlled file** | The governed artefact is always a PDF; `.docx` stays the source | Technically simplest and matches how many regulated organisations already work, where the approved artefact is the signed PDF. It does constrain authoring, and some customers will resist |

**Recommendation: A**, and let a design partner tell us whether it matters. Many customers
will naturally arrive at D on their own, because their approved artefact already is a PDF.
If it turns out to matter, C is the one to price — but it moves customer document content
out of the EU region, which makes it a residency decision as much as a cost one.

**Consequence of A.** One line of `evidence-model.md` changes, and the manifest gains a
recorded absence rather than a silent one.

**Reversibility.** High. Renderings are derived artefacts (`ADR-0004`); adding conversion
later regenerates them for existing packs on request.

**Blocks.** Nothing. It affects Pilot evidence output only.

---

## Decided

The reasoning stays in the numbered section above each decision, because *why we chose
file-centric* is a question that will be asked again.

| # | Decided | Date | Answer | Where the consequence landed |
|---:|---|---|---|---|
| 1 | Pilot `LegalEntity` capability | 2026-08-24 | Schema-complete, behaviour-minimal. `LegalEntity`, `OrgUnit` and `OrgMembership` exist from the first migration; one entity seeded per tenant; the resolver does no hierarchy traversal until V1 | `domain-model.md`, `multi-entity-model.md` Pilot scope |
| 2 | Authoring model | 2026-08-24 | File-centric. The uploaded controlled file is the governed artefact and the thing hashed. Text extraction feeds comparison and materiality warnings and is never normative | `versioning.md`, `domain-model.md` |
| 7 | Data residency | 2026-08-24 | One EU region, complete — application data, object storage, backups, search, audit, evidence packs, queues, DR replicas and observability all in-region | Phase 1: ADR-0000 and the infrastructure ADRs |
| 6 | Licence | 2026-08-24 | PolyForm Shield 1.0.0, and the repository goes public | Phase 2: the licence file. Blocked on decision 8 for a licensor and a name |
| — | Application language | 2026-08-24 | TypeScript end to end. The founder reviews every agent-written pull request, and their fluency dominates any technical argument | `ADR-0000` |
| — | Repository visibility | 2026-08-24 | Public. The CI gate list assumes unlimited Actions minutes | `ADR-0000`, and decisions 6 and 8 |

Decision 7 has no effect on `docs/domain/`. It constrains provider and managed-service
choices in Phase 1, and it is the commitment the security documentation will state.

## Settled elsewhere — do not reopen

Recorded so that these do not resurface as open questions. Each was decided during
consolidation and the reasoning is in `docs/domain/consolidation-notes.md`.

| Question | Answer | Where |
|---|---|---|
| Is `Space` an authorization scope or an applicability input? | No, to both | INV-AUTH-015, INV-APL-010, refinement 17 |
| Are waivers in the Pilot? | No — V1, modelled from the start | Contradiction 6 |
| Does an overdue review invalidate an effective version? | Never | INV-REV-001 |
| Who classifies materiality? | A human, confirmed at approval | INV-VER-014 |
| Is there a runtime AI dependency in any domain operation? | No | AGENTS.md rule 6 |
| Is an attestation a qualified electronic signature? | No, and the product never implies it | `glossary.md` |
| Is the aggregate called `Policy` or `Document`? | `Document` | `glossary.md` |
| May two versions be effective at once for one scope? | Only for different scopes, and never ambiguously | INV-EFF-002, INV-APL-002 |
| Do we ship per-PR preview environments in the Pilot? | No | `consolidation-notes.md`, departures |
