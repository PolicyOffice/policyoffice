# Product Blueprint

What this product is, who it is for, and — at least as importantly — what it refuses to
become.

`docs/domain/` is the authority on how the product behaves. This chapter is the authority
on why it exists and where its edges are. When a feature request arrives, the question is
not whether it would be useful; it is whether it belongs inside these boundaries.

## Mission

> Give regulated and compliance-heavy European organisations one trustworthy operational
> system for governing documents across creation, approval, applicability, distribution,
> acknowledgement, review, retirement and evidence.

The guiding test for every feature and every architectural decision, repeated from
`AGENTS.md` because it is the sentence that settles arguments:

> **Does this make the system better able to prove which document version governed whom,
> at what time, under what authority, and with what evidence?**

## The five questions

The product exists to answer these reliably, and historically, in minutes rather than
weeks:

1. **What governs this person**, in this legal entity, function, jurisdiction, on this
   date?
2. **What exact text was approved and effective** at that point in time?
3. **Who reviewed and approved it**, under which workflow and on whose authority?
4. **Who was required to receive or acknowledge it**, and what happened?
5. **Can the organisation prove all of the above** quickly, to an auditor, a regulator, a
   customer or an internal investigator?

Everything in the specification serves one of those five. A capability that serves none of
them is, at best, someone else's product.

## Positioning

There are three kinds of tool in this space, and the product sits deliberately between
them.

| Category | Examples | What they prove | The opening |
|---|---|---|---|
| **Document and knowledge platforms** | SharePoint, Confluence, Notion | Permissions, version history and approvals are table stakes, and buyers already have them | Their control layers are fragmented and generic. A page approval is not an approval record bound to a digest, and a folder tree is not applicability |
| **Policy-native specialists** | PowerDMS, MetaCompliance, NAVEX | The category is real: buyers pay for control, traceability and proof, not storage | Frequently verticalised — public safety, healthcare — or part of a broader human-risk suite, with enterprise sales motions that do not fit European mid-market |
| **Broad governance suites** | OneTrust and comparable GRC platforms | Large organisations will buy an entire governance programme | Overbuilt for a company that wants document governance, attestation, access control and evidence without a governance transformation |

Which gives the position:

> **More controlled than SharePoint, Confluence or Notion. Lighter and faster to operate
> than a GRC suite. More relevant to European regulated mid-market operations than
> vertically specialised policy tools.**

The differentiation is explicitly **not** "we have approvals". Confluence and SharePoint
both have approvals now. The differentiation is the coherence of the whole: policy-native
state, deterministic applicability resolution, multi-entity and jurisdictional governance,
and evidence generated from authoritative records.

> Competitive observations here come from the archived research in `docs/research/`, which
> is point-in-time and non-normative. Vendor capabilities change. The *structural*
> observation — that generic tools govern pages and specialists govern verticals — has
> held long enough to build on.

## Who it is for

**Initial ICP: regulated or semi-regulated European organisations of roughly 50 to 2,000
people**, already using Microsoft 365, Google Workspace or Okta, operating across several
departments and increasingly across several legal entities or jurisdictions, whose
document estate has outgrown a shared drive and a spreadsheet.

In practice: payment and e-money institutions, investment and lending firms, insurtechs,
crypto-asset service providers, cybersecurity vendors, healthtechs with formal quality
systems, and B2B software companies preparing for ISO 27001 or a serious customer security
review.

**Beachhead: the Baltics, Poland and Finland.** Not the largest European market, but an
unusually good one to start in — dense regulated-fintech activity, cross-border operating
models by default, and high cloud adoption. Cross-border by default matters more than it
sounds: it means the multi-entity and jurisdiction model is exercised by ordinary
customers rather than by a rare enterprise deal.

The segment below this one — small organisations that mainly need to stop losing track of
documents — is served by the **Essential** governance profile rather than by a different
product. See `docs/domain/configuration-model.md`.

## What the product is not

Stated as refusals, because each one is a direction the product could plausibly drift in.

| Not | Because |
|---|---|
| A general wiki | Collaboration tooling is a different product with different economics. Integrate; do not compete |
| A Microsoft Office replacement | Customers author in Word. Trying to beat Microsoft at authoring is how a governance product loses |
| A document management system for every corporate record | Contracts, invoices and HR files are someone else's problem. Governed instruments are ours |
| A complete GRC suite | Risk registers, control testing, third-party risk and privacy programme management are adjacent. Links to them are future work; becoming them is not |
| A contract lifecycle management platform | Different lifecycle, different counterparties, different law |
| A learning management system | Acknowledging a document is not training, and a quiz is not evidence of governance |
| A regulatory advice engine | The product records what an organisation decided. It does not tell them what the law requires |
| An e-signature platform | An acknowledgement is not a qualified electronic signature, and the product never implies it is |
| An AI writing product | Content is authored by accountable humans. See below |
| An employee monitoring system | Covered below, because it is the easiest failure to walk into |

## Principles

| Principle | Consequence |
|---|---|
| There is always an answer to *what applies now* | Resolution is a core domain service, not a interface filter |
| History is first-class | Any past instant can be reconstructed from authoritative records |
| Released content is immutable | A released version is never edited in place |
| Review is not publication | Comment and revision happen before an immutable version exists |
| Publication is not effectivity | Future-effective documents can be distributed in advance without binding early |
| Permissions are not applicability | Read access and obligation are computed separately |
| Applicability is deterministic | Identical inputs produce identical results, always |
| Ambiguity blocks governance actions | Conflicts fail closed rather than producing an arbitrary winner |
| Automation reminds and escalates; it never invents authority | Nothing auto-approves because somebody missed a deadline |
| Evidence is generated from source records | Packs are deterministic and verifiable, not assembled screenshots |
| Personal data is minimised deliberately | Auditability does not justify recording everything forever |
| AI stays advisory | It may propose; it may never decide, approve or rewrite a governed record |

Each of these is enforced by named invariants in `docs/domain/invariants.md`. They are
product commitments, not aspirations, and none of them has a configuration switch
(INV-CFG-001).

## Two positions worth defending explicitly

### The product runs without an LLM

No runtime AI dependency exists in any domain operation: applicability, authorization,
approval, effectivity, attestation, audit or evidence. This is a product position before
it is a cost position.

A governance record whose correctness depends on a model's output is not a governance
record. AI arriving later — change summaries, proposed classifications, drafted alignment
— is useful precisely *because* the underlying records are trustworthy without it.
Building in the other order produces a product that is confidently wrong about the state
of the organisation.

It is also, incidentally, what makes the product cheap to operate and easy to explain to a
security reviewer.

### It must not become surveillance

A compliance product has unusually easy access to a tempting failure: recording everything
every employee does, and justifying it with "an auditor might want it".

That is not a lawful basis, and a product that quietly becomes an employee monitoring
system has betrayed the compliance function it serves. So the defaults are:

- reading telemetry is **off**, and disabled by default even where the capability exists;
- IP address, user agent and device metadata are **not** recorded on attestations by
  default;
- audit events record governance transitions, not page views or searches;
- evidence packs default to the `STANDARD` privacy profile rather than the fullest one;
- a tenant that genuinely needs more configures it deliberately, and that configuration is
  itself audited.

`docs/domain/audit-event-catalogue.md` and `docs/domain/evidence-model.md` specify the
mechanics. The position is here because it is a product decision, not a technical one.

## Boundaries with the customer's other systems

| System | Relationship |
|---|---|
| Identity provider — Entra, Google, Okta | **Integrate.** Standards-first: OIDC, SAML, SCIM. The customer's IdP owns password policy and MFA; the product owns entitlement inside the tenant |
| Microsoft 365 / Google Workspace | **Integrate.** Authoring happens there. Governance happens here |
| Wiki and knowledge base | **Coexist.** Reference a governed document from the wiki; never let the wiki's page tree become the source of authority |
| HR system | **Consume.** Org structure and joiner/mover/leaver events feed memberships; the product is not a system of record for employment |
| GRC / risk platform | **Link, later.** `DocumentRelationship` and `ExternalReference` are modelled and not built |
| SIEM | **Export.** Audit events go out; the evidence ledger stays authoritative here |

## Commercial packaging

Deliberately not specified here, and never encoded in the domain.

Governance profiles — Essential, Standard, Regulated — describe **how an organisation
governs**. A plan describes **what they pay for**. The two must not be conflated: a small
customer may need EU residency, and a large one may not need SCIM. Packaging may reference
profiles; the domain model never mentions price (`docs/domain/configuration-model.md`).

## How this product fails

Recorded so the failure modes are recognisable early:

1. **It becomes a wiki.** Feature requests pull toward collaboration, and the governance
   spine stops being the point.
2. **It becomes a GRC suite.** Each adjacent module is individually reasonable, and
   collectively they produce a platform nobody can operate or afford.
3. **It ships AI first.** A change-summary button demos well and proves nothing, while the
   records underneath stay untrustworthy.
4. **It becomes surveillance.** Telemetry accumulates because it is easy and someone might
   want it.
5. **Compliance fatigue.** Everyone re-attests to everything, acknowledgement becomes
   reflexive clicking, and the evidence is worthless despite being complete.
6. **It is helpful instead of correct.** Ambiguity gets resolved by picking something
   reasonable rather than failing closed, and one day that pick is the difference between
   a fine and a finding.

The sixth is the dangerous one, because every individual instance looks like good product
judgement.
