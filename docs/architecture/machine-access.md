# Machine and AI Access

Design constraints for the day another system — an integration, a customer's assistant, an
AI agent — asks this product what governs someone.

> **Status: constraints, not a commitment.** Nothing here is scheduled and nothing here is
> an ADR, because no decision is being taken yet. This chapter exists so that the decisions
> already taken are not quietly undone by a later one, and so the reasoning survives
> longer than the conversation that produced it.

## The problem this addresses

The manual work in using a policy with an AI system is not finding the file. It is proving
the file is the right one.

Today a person searches a share, finds `Anti_Bribery_Policy_FINAL_v4.pdf`, uploads it to an
assistant, asks a question — and then has to establish, by hand and outside the tool, that
this was the approved version, that it was in force on the date in question, and that it
applied to the person the question is about. The upload takes ten seconds. The verification
takes the rest of the afternoon, and it is the part nobody records.

Every governance fact needed to remove that step is already an authoritative record in this
product. That is the whole of the opportunity, and it is why it costs almost nothing to
stay ready for it.

## Why this is written now rather than later

Three things changed while this specification was being written, and each of them is
external to us.

| Development | Consequence here |
|---|---|
| Model Context Protocol became a vendor-neutral standard under the Linux Foundation's Agentic AI Foundation, with a substantial specification revision on 2026-07-28 | There is now one protocol to target rather than one integration per assistant vendor. A future adapter is a smaller piece of work than it looked a year ago |
| Regulated-sector vendors began announcing agent interfaces — [Comply](https://www3.comply.com/comply-ai-mcp-server-wl) (RegTech; MCP server on a waitlist, beta announced for May 2026 and general availability for July, neither confirmed as at 2026-08-25) and IBM OpenPages 9.2 (GRC, announced March 2026) | The category is being staked out now. Announced or not, neither addresses version authority, effectivity or point-in-time resolution — the questions this product is built around. See `docs/product/product-blueprint.md`, *The machine interface will not be the differentiator* |
| Deployers of high-risk AI face automatic-logging obligations under the EU AI Act, and published guidance on adequate logs includes the **version of the reference data relied on** at each interaction | If a customer's agent acts on an internal policy, the policy version identity is part of *their* regulatory log. We are the only party who can supply it truthfully |

The third is the commercially interesting one, and it inverts the usual argument. The
question stops being *does PolicyOffice have AI features* and becomes *can you produce, for
each agent interaction, the identity of the rule it relied on*. A document repository
cannot answer that. This product answers it already, for humans.

> **Unverified.** The AI Act's applicability dates are phased, were amended during 2026,
> and are read differently by different commentators. Nothing in this chapter depends on a
> specific date, and no date should reach a customer-facing claim without counsel. The
> product records what an organisation decided; it does not advise them on the law
> (`docs/product/product-blueprint.md`).

## What is already true

Most of the architecture this would need is specified and needs no change. Recorded here so
nobody re-derives it.

| Requirement | Where it already lives |
|---|---|
| Policy identity is separate from version, content and file | `Document` · `DocumentVariant` · `DocumentVersion` · `ContentRevision` · `ContentAttachment` |
| Identity is opaque and survives re-coding and re-titling | Cross-cutting rule 2, `docs/domain/domain-model.md` |
| "Effective" is derived from a dated interval, never a mutable flag | INV-EFF-006; *What is deliberately not an entity* |
| Point-in-time resolution of version, membership and audience | INV-APL-009, INV-EVD-007 |
| Resolution takes a scope descriptor, not a logged-in user | `docs/domain/multi-entity-model.md` — *The resolver takes a scope, not a person* |
| One authorization evaluator on every surface, including search and jobs | INV-AUTH-001, INV-AUTH-010, INV-AUTH-011 |
| Applicability and access are permanently separate questions | INV-AUTH-005 |
| Tenant isolation is structural, not filtered | INV-TEN-001…005 |
| Governance logic lives below the interface, in a framework-free domain package | `ADR-0000`, `README.md` |
| Machine principals authorised identically to humans | INV-AUTH-010, INV-AUTH-018 |
| Outbound events off an append-only ledger cursor | `ADR-0006`, `webhook_subscription` |

An adapter over these is an adapter. A retrofit of these is a rewrite. The distinction is
the entire point of writing this down early.

## Constraints that must hold from now

Five. Each is cheap today and expensive after the fact.

### 1. Authority is intersected, never unioned

> **INV-AUTH-018** — see `docs/domain/authorization-model.md`, *Machine principals and
> delegated authority*.

An assistant provisioned once by an administrator, then answering every employee with the
administrator's reach, is the failure mode of this entire category. It will not present as
a bug. It will present as the integration working.

### 2. An answer carries its own provenance

Any machine-facing response naming a policy carries enough to be cited and re-verified
independently:

```text
document id · version id · version sequence and display label
lifecycle state · effective interval · content digest
resolved scope and instant the answer was computed for
configuration version in force
canonical address
```

The digest matters more than it looks. It is what lets a customer's own AI Act log record
*which bytes* the agent relied on, and lets that claim be checked years later against an
evidence pack. Chunks of anonymous text with no version identity are not an answer this
product is permitted to give — they are the thing it exists to replace.

### 3. Retrieval is authorised at retrieval

INV-AUTH-011 already says a stale index must not leak. The machine case adds an emphasis
rather than a rule: no corpus, index or embedding store may be the thing that decides who
sees what. Derived retrieval artefacts are rebuildable caches over authoritative records —
never a parallel copy of the estate with its own access model, and never shared across
tenants.

### 4. Freshness is bounded by the effective interval

Any cache of an answer — the protocol's own response caching included — is valid only until
the next known effectivity transition for what it describes. That instant is not a guess:
it is `effective_until`, or the `effective_from` of a scheduled successor, both of which are
already stored.

This is the cleanest advantage the model gives. Generic retrieval over a document store
cannot know when its answer expires, because nothing in a file says when it stops being
true. Here it is a column, and supersession already emits an event that can invalidate
downstream context.

### 5. Machines find and explain; they do not decide

Approval, publication, supersession and attestation stay human, per AGENTS.md rule 5 and
the *AI stays advisory* principle. A machine interface is read-first; any later write path
creates drafts and tasks that a person disposes of. The audit ledger already distinguishes
who acted from whose authority they acted under (INV-AUD-006), so a proposal that came from
an agent is never indistinguishable from a decision that came from an officer.

## Where the adapter is not free

Worth stating plainly, because "it's just an adapter over application services" is true of
everything except this.

`ADR-0002` chose server-side session rows over tokens, deliberately — deactivation becomes
immediate rather than eventual. The MCP specification of 2026-07-28 makes a server an OAuth
2.1 **resource server**: it validates presented tokens and does not issue them, with
protected-resource metadata (RFC 9728) and resource indicators (RFC 8707) so a client can
discover the right authorization server and scope a token to one destination.

Those are not in conflict, but they are not the same path either. A token-validating entry
point that resolves to a principal and then calls the same evaluator is a genuine piece of
work, and it is the one part of this that a future estimate should not treat as trivial.
It is also the correct place for it: one entry point, one evaluator, no second answer to
*may this principal see this*.

## What we are not building

Unchanged from `docs/product/scope-and-roadmap.md`, restated because a chapter like this
one attracts scope:

- no MCP server, no vendor connectors, no agent framework;
- no embeddings or vector store — full-text search over authorised effective content is
  what the Pilot ships, and `data-model.md` already records that;
- no runtime LLM in any domain operation, ever (AGENTS.md rule 6). This is not a staging
  decision that later relaxes. It is why the records are worth connecting to at all;
- no AI-drafted, AI-approved or AI-published governed content.

The Pilot ships the golden slice. Nothing in this chapter is allowed to compete with that.

## Review triggers

Re-examined when any of these happens, rather than on a calendar:

- the public API is scheduled, since it fixes the contract this would sit on;
- a design partner asks to connect an assistant — the first real requirement, worth more
  than the whole of this chapter;
- the MCP specification revises authorization again, or the enterprise extensions land;
- a competitor ships version-aware, permission-aware policy retrieval, which would make
  this a response rather than a position;
- the AI Act logging expectations settle enough to be described accurately.
