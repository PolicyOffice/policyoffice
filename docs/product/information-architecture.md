# Information Architecture

Two experiences, deliberately different, resting on one model.

> **Spaces organise administration. Applicability governs obligation. Permissions govern
> visibility.**

Those three are independent, and the interface must never imply otherwise. A document can
sit in the Information Security space, be owned by the Security function, apply to every
employee of three legal entities, have a Finnish translation, and be visible to an
external auditor through a seven-day grant. Five relationships, no hierarchy among them.

## The organising decision

An employee should not encounter a governance console to find the travel policy.

| | Reader experience | Governance experience |
|---|---|---|
| Who | Every employee and contractor | Compliance, owners, authors, approvers, auditors |
| Volume | Almost all users, a few times a year | Few users, constantly |
| Organised around | *What applies to me, and what must I do* | *What is broken, and what needs a decision* |
| Domain vocabulary exposed | Almost none | All of it |
| Success | They leave in under a minute | They never have to ask "what is overdue?" in a meeting |

Building one interface for both is the common mistake. It produces a compliance cockpit
that employees bounce off and a reader view that compliance managers find useless.

## Reader experience

```text
Home
├── My documents          what applies to me, and why
├── My actions            attestations outstanding, with deadlines
├── Recently changed      what moved, and what changed in it
└── Search
```

Rules that make it work:

| Rule | Reason |
|---|---|
| The effective version is the default and the obvious one | *Current* is the only question a reader has |
| Historical versions are visually unmistakable as historical | Reading a superseded policy and believing it is the failure mode with real consequences |
| A future-effective version is labelled with the date it binds | Published is not effective, and the reader must never have to know that phrase to understand the label |
| *Why does this apply to me* is answerable in one click | Entity, function, jurisdiction — expressed in the customer's own words |
| Search defaults to effective content the reader may access | Historical and pre-release results require an explicit mode, and permission |
| No result, count, facet or breadcrumb reveals restricted content | INV-AUTH-011, INV-AUTH-012 |
| Acknowledgement shows the exact version, the change summary and the statement | INV-ATT-002. The wording presented is part of the evidence |
| Language selection never changes what applies | INV-APL-006 |

## Governance experience

Organised around exceptions first, because a register sorted alphabetically tells nobody
what needs attention.

```text
Needs attention                    ← the landing page, not a report
├── Approvals overdue
├── Reviews due and overdue
├── Campaigns below target
├── Unowned documents
├── Blocked approval runs
├── Stale variants awaiting alignment
├── Unresolved applicability conflicts
├── Policy gaps
└── Access grants expiring

Documents        register · drafts · in review · published · effective · superseded · retired
Approvals        my decisions · runs · templates
Reviews          due · overdue · completed · schedules
Attestations     campaigns · completion · exceptions
Evidence         packs · audit explorer · point-in-time reconstruction
Organisation     legal entities · org units · jurisdictions · governance bodies · people and groups
Administration   document types · workflows · statements · retention · identity · security
```

Two properties of the exceptions list matter more than its contents:

**Every tile drills through to the affected records.** A number that cannot be expanded
into the rows behind it is a vanity metric, and worse, an unfalsifiable one.

**Every count reconciles against source records.** If the dashboard says eleven reviews
are overdue, exactly eleven review cases satisfy that predicate. Cached aggregates that
drift are how a governance dashboard becomes something people stop trusting and then stop
opening.

## Key surfaces

| Surface | Job | Non-obvious requirement |
|---|---|---|
| **Register** | Find any document and see its governance state | Filters must never reveal documents the user cannot access — including through result counts |
| **Document record** | The stable page for the logical document, not a version | Tabs: Current · Variants · History · Approvals · Reviews · Attestations · Access · Evidence |
| **Reader view** | Show the effective version and what is required | Scope, owner, effective date and required actions above the text |
| **Draft workspace** | Upload the candidate file and classify the change | Content is file-centric, so a new revision is an upload rather than an edit. Comparison against the current effective version, and the deterministic materiality warnings, at the point of classification |
| **Approval inbox** | Decide on exactly what was submitted | The exact revision, its digest, the change summary, the scope, and prior decisions — all before the decision buttons |
| **Attestation** | Acknowledge one exact version | The statement wording is shown, not summarised. Acknowledge, never *sign* |
| **Campaign builder** | Target an audience and launch | Preflight results are shown before launch, naming who cannot access the version (INV-AUTH-007) |
| **Evidence workspace** | Request a pack for a document, campaign or instant | Privacy profile chosen explicitly, and its consequences stated in plain language |
| **Audit explorer** | Trace what happened | Filter by actor, subject, correlation. Never a request log |

### The approval inbox deserves a note

It is where the product's central promise either holds or quietly fails.

A reviewer who approves without having seen what they were approving has produced a record
that says the opposite of the truth. So the decision controls come *after* the content,
the digest is visible and comparable, and prior decisions on this candidate are shown
before the buttons rather than behind a tab.

Making approval fast is a reasonable interface goal in most products. Here it is
subordinate to making approval *accurate*.

## Addresses

URLs are a public contract. A wiki links to a policy, an intranet page embeds one, an
auditor pastes one into a finding, and later an external system cites one. Changing the
shape afterwards breaks all of them at once, so the shape is decided before the first
route is written rather than falling out of a router's defaults.

| Address | Resolves to |
|---|---|
| `/documents/{documentId}` | The document record. Stable for the life of the document, across re-titling, re-coding and re-typing |
| `/documents/{documentId}/effective` | Whatever governs the requester's scope **now**. The link to paste into a wiki |
| `/documents/{documentId}/versions/{versionId}` | One exact version. What a citation, an approval record or an evidence pack points at |
| `/documents/{documentId}/as-of/{instant}` | What governed the requester's scope at that instant (INV-EVD-007) |

Three rules hold regardless of the eventual routing scheme:

- **Identity in the path is the opaque identifier, never `document_code`.** A customer who
  re-codes their register must not break every link they have published. The code is a
  display attribute and belongs in the page, not the address.
- **An address is not an authorization.** Every one of the above resolves through the
  evaluator, and an unauthorised or cross-tenant identifier is not-found, never
  forbidden-with-metadata (INV-TEN-005, INV-AUTH-012).
- **`/effective` and `/as-of` are resolutions, not redirects to a winner.** They answer for
  the requester's scope, so two people opening the same link may legitimately reach
  different versions, and the page says which scope produced the answer.

## Vocabulary in the interface

The interface uses the tenant's configured labels over our internal ones wherever they
differ — their document type names, their body names, their word for a waiver. The
ubiquitous language in `docs/domain/glossary.md` governs the code, the API and the
database; it does not oblige a customer to call something a Manual when their governing
framework calls it an Instruction.

Two terms are never customer-configurable, because they carry claims:

- **Acknowledge**, never *sign*. An acknowledgement is not a qualified electronic
  signature.
- **Effective**, never *current*. "Current" blurs published, effective and latest-drafted,
  and the blur is exactly what the product exists to remove.

## Accessibility and language

| Requirement | Why it is a governance concern, not just good practice |
|---|---|
| Keyboard and screen-reader accessible reader path | An employee who cannot complete an acknowledgement has an unmet obligation the organisation cannot discharge |
| Locale-aware deadlines, with the timezone stated | A deadline displayed without its zone is a dispute waiting to happen (INV-TIME-001) |
| Interface language independent of document language | Reading the Finnish translation must not require a Finnish interface, and vice versa |
| Plain-language reader copy | Domain terms in the reader path are a design defect |

## What the reader must never see

| Never | Instead |
|---|---|
| Governance exceptions and overdue queues | Their own outstanding actions |
| Draft or in-review content | Nothing. It does not exist for them |
| Documents that apply to them but which they cannot read | This is a governance defect, surfaced to compliance — not a broken screen shown to the employee |
| Approval mechanics, materiality classes, variant types | The resolved answer, in ordinary words |
| Another tenant's existence, in any form | Not found, with no timing or count difference (INV-TEN-002, INV-TEN-005) |
