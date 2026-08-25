# PolicyOffice

> A policy operations system of record for regulated European companies.

A system of record for controlled policy operations: policy lifecycle, immutable
approved versions, review and approval workflows, applicability, access, distribution,
attestations, scheduled reviews, audit history, and regulator-ready evidence — built for
regulated and compliance-heavy European organisations.

It is deliberately **not** a wiki, a document store, or a general GRC suite.

The guiding test for every feature and architectural decision:

> Does this make the system better able to prove which policy version governed whom, at
> what time, under what authority, and with what evidence?

## Status

**Phase 2 in progress — repository bootstrap.**

The specification is written and settled: 16 chapters under `docs/domain/` and
`docs/product/`, and 149 invariants with stable identifiers. The architecture is derived
from it: eleven ADRs, a physical data model and a threat model under `docs/architecture/`.

The platform those ADRs depend on is **executed, not assumed** — 34 assertions against
local PostgreSQL and 24 against Neon, in `verification/`. Six ADR claims turned out to be
wrong and were amended. There is no schema yet.

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
| `packages/domain/` | The framework-free domain package. Imports nothing outside an allowlist |
| `apps/web/` | Next.js App Router — the reader and governance surfaces |
| `apps/worker/` | The worker process. Depends on the domain, never on `apps/web` |
| `tooling/` | The architecture test enforcing the domain boundary |
| `verification/` | Executable checks for the platform claims the ADRs depend on |

## Development

Requires [Node 24](https://nodejs.org) (`.nvmrc`), [pnpm](https://pnpm.io) and Docker.

```bash
nvm use && corepack enable && pnpm install
```

```bash
docker compose up -d && ./verification/run.sh
```

That second command is the platform verification, not a test suite — there is no
application to test yet. It proves PostgreSQL behaves the way the ADRs claim.

Everything the CI gate list runs, in one command:

```bash
pnpm check
```

which is `format`, `lint`, `typecheck`, `test` and `build` — each also runnable on its
own, because CI runs them as separate jobs and one job should have one reason to go red.

`pnpm test` includes the **architecture test**, which fails if `packages/domain` imports
anything outside its allowlist. That boundary is what makes INV-TEN-004 and INV-AUTH-001
enforceable rather than remembered, so it is part of the ordinary check commands and not
an opt-in script.

The platform check against Neon needs credentials and is therefore separate:

```bash
set -a; . ./.env; set +a && ./verification/neon.sh
```

## How this is built

Specification-first, agent-implemented, deterministically gated. The workflow — agent
lanes, review tiers, the decision-escalation protocol and the merge policy — is
documented in [`docs/engineering/agent-workflow.md`](docs/engineering/agent-workflow.md).

## Licence

[PolyForm Shield 1.0.0](LICENSE) — source-available: readable by anyone, not re-sellable as
a competing service.

Licensor: **Aksel Costa**. Copyright will be assigned to the operating company once it is
incorporated, and the licence updated in the same commit.
