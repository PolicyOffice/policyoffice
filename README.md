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
wrong and were amended. The migration chain now contains the tenancy and identity
foundation; the remaining Phase 2 schema arrives in dependency order.

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

which is `format`, `lint`, `typecheck`, `invariants`, `test` and `build` — each also
runnable on its own, because CI runs them as separate jobs and one job should have one
reason to go red.

Tests come in three kinds, selected by filename so the boundary is visible in the file
tree rather than in configuration:

| Command | Runs | Needs |
|---|---|---|
| `pnpm test:unit` | `*.test.ts` | nothing |
| `pnpm test:integration` | `*.int.test.ts` | `docker compose up -d` |
| `pnpm test:tenant-isolation` | the schema-discovered tenant isolation suite | `docker compose up -d` |
| `pnpm test:property` | `*.prop.test.ts` | nothing |

Integration tests connect as `app_role` — never the owner, never a superuser. A superuser
bypasses row-level security entirely, so a cross-tenant negative test run as one passes
while proving nothing. The harness enforces the role rather than trusting each test to
remember it, and a test that cites a tenancy or authorization invariant while holding a
privileged connection fails outright.

They **fail** rather than skip when no database is reachable. A skipped integration suite
is a green build that tested nothing.

Migrations are forward-only, hand-written SQL, applied by our own runner:

```bash
pnpm --filter @policyoffice/db migrate
pnpm --filter @policyoffice/db migrate:status
```

`migrate` applies what is pending, `migrate:new <slug>` creates the next file. **There is
no revert command, and no down migration to revert to** — a down migration is a data-loss
tool pointed at an evidence ledger, so recovery is a forward migration or a restore. A
merged migration is immutable: the runner records a checksum and refuses to proceed if a
file changes.

`MIGRATION_DATABASE_URL` is an administrative connection, defaulting locally to the
Docker Compose `postgres` role. That connection is used only to create or constrain the
three roles and to grant an explicit `SET ROLE` path. The runner executes every ordinary
migration and owns its checksum ledger as `migration_role`, which remains
`NOSUPERUSER NOBYPASSRLS`; new migration files do not need to switch roles themselves.

Deterministic local fixtures are separate from migrations and from each other:

```bash
pnpm db:seed:reference
pnpm db:seed:development
pnpm db:seed:test
```

Each command runs against Docker Compose with no arguments and is safe to repeat. Reference
values are PostgreSQL enum labels owned by the migration chain. Development fixtures load
one tenant with one legal entity, three users, two groups and a small copied Standard
taxonomy. Test fixtures load two tenants and at least one row in every tenant-owned table,
including both closed and open organisation memberships.

The loaders execute tenant-root provisioning as `migration_role` and every tenant-owned
insert as `app_role` under a transaction-local tenant context. They refuse development or
test data in `NODE_ENV=production`. The only audit history they create is the genuine
initial `configuration.changed` transition for each fixture tenant; no history is
backfilled to make the fixtures look lived-in.

```bash
pnpm db:verify
```

runs the three checks `ADR-0009` requires — fresh install, upgrade with data present, and
schema drift between the migration chain and the Drizzle definition — each against a
throwaway database.

`pnpm invariants` checks that every invariant in the registry either has a test naming it
or appears in `tooling/invariants-pending.md` with a reason. That register only shrinks,
and the check fails if an invariant is both tested and still listed.

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
