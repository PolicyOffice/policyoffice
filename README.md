# Policy Operations Platform

> Working name. Product and repository naming is an open decision.

A system of record for controlled policy operations: policy lifecycle, immutable
approved versions, review and approval workflows, applicability, access, distribution,
attestations, scheduled reviews, audit history, and regulator-ready evidence — built for
regulated and compliance-heavy European organisations.

It is deliberately **not** a wiki, a document store, or a general GRC suite.

The guiding test for every feature and architectural decision:

> Does this make the system better able to prove which policy version governed whom, at
> what time, under what authority, and with what evidence?

## Status

**Phase 0 — specification consolidation.** No application code yet. The product and
domain research is being consolidated into the canonical specification under `docs/`,
after which architecture is selected and the repository is bootstrapped.

## Repository map

| Path | Contents |
|---|---|
| `AGENTS.md` | Entry point for coding agents — the map, and the rules that may not be broken |
| `CLAUDE.md` | Claude Code's specific lane |
| `CONTRIBUTING.md` | Branch, commit, review and merge conventions |
| `docs/product/` | Product blueprint, personas, information architecture, scope and roadmap |
| `docs/domain/` | Canonical domain model, business rules, lifecycles, and the invariant registry |
| `docs/architecture/` | Architecture, data model, threat model, ADRs |
| `docs/engineering/` | Agent workflow, testing strategy, definition of done, release process |
| `docs/plans/` | Pilot plan, active and completed work plans, technical debt |

## How this is built

Specification-first, agent-implemented, deterministically gated. The workflow — agent
lanes, review tiers, the decision-escalation protocol and the merge policy — is
documented in [`docs/engineering/agent-workflow.md`](docs/engineering/agent-workflow.md).

## Licence

Not yet selected. Intended posture is source-available: readable by anyone, not
re-sellable as a competing service.
