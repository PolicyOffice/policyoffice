# Phase 2 — Repository Bootstrap

Turn the architecture into a repository that can accept a Codex-ready ticket: a local
environment, a verified platform, a migration chain, and CI that actually gates.

**Phase 2 is complete when a ticket can be implemented, tested and merged without anyone
setting anything up by hand.**

## What Phase 1 handed over

| Input | Consequence |
|---|---|
| Eleven ADRs, each with a *verify at bootstrap* list | The first task, before any migration |
| `data-model.md` — 46 entities, an enforcement map | What the migrations build |
| `threat-model.md` | The CI gates that matter, and why |
| Decision 8 — the product is PolicyOffice | Repository name, licence, package scope |

## Conventions for this phase

- **Verify before building on it.** Every ADR claim that a migration will depend on is
  executed first. An assertion that has never run is a guess.
- **Nothing costs money.** The budget posture holds; anything that would is a Decision
  Request.
- **CI gates are deterministic.** No AI in the required-check path, ever.
- **A finding amends the ADR**, in the same pull request, marked and dated — with the
  wrong reasoning kept rather than deleted.

## Done

- [x] **Project infrastructure**, recorded here because it is not discoverable from the
  code:
      `policyoffice.eu` is registered at Namecheap with a catch-all email forward to the
      founder's inbox — anything`@policyoffice.eu` is deliverable. DNS stays at Namecheap
      until a deployment needs real records, at which point it moves to Cloudflare. The
      GitHub organisation is `PolicyOffice`; `.ee` and `.io` are unregistered but were free
      as at 2026-08-25, and `.com` is held by a brand marketplace at roughly €7k
- [x] **Neon is provisioned** (2026-08-25): organisation `PolicyOffice`, project
      `PolicyOffice`, **AWS Europe Central 1 (Frankfurt)**, Postgres 18, free plan. Neon Auth
      deliberately left off — `ADR-0002` chose server-side sessions in Postgres, and a vendor
      auth product owning users and sessions would take INV-AUTH-014's revocation mechanism
      out of our hands. Both connection strings, pooled and direct, are in the founder's
      local `.env` and are not committed. Cloudflare R2, Resend and Sentry remain
      unprovisioned
- [x] **Service accounts use per-service `@policyoffice.eu` addresses**, never a personal
      address and never GitHub OAuth — a GitHub organisation is not a login identity, so the
      OAuth button would tie production infrastructure to a personal account that will not
      transfer to `PolicyOffice OÜ`. Note that the DNS move to Cloudflare is also an
      email-routing move: if the catch-all is not re-created, every service account's
      recovery address fails at once

- [x] `docker-compose.yml` — Postgres 18, MinIO for S3-compatible object storage, Mailpit
      for outbound mail. One command, no accounts, no cost
- [x] `.env.example` — the application connects as a restricted non-owner role, never as
      the superuser
- [x] `verification/` — executable checks for the platform claims the ADRs depend on.
      34 assertions across 5 checks, all passing against PostgreSQL 18.6, from a clean volume

### What verification found

Four findings, every one of them from executing something rather than reviewing it. Full
detail in `verification/README.md`.

- **`ADR-0005`** — `tstzrange(null, null)` is `(,)`, unbounded, not null. A withdrawn
  version would have claimed all of time and blocked its whole variant. And the underlying
  idea was also wrong: withdrawal must *close* the interval, not null it, or the period
  the version actually governed disappears and point-in-time reconstruction breaks.
- **`ADR-0001`** — `FORCE ROW LEVEL SECURITY` binds the table owner but not a superuser.
  So the migration role must not be a superuser, and **integration tests must never
  connect as one** — a cross-tenant negative test run as a superuser passes while proving
  nothing.

Then the move from Postgres 17 to 18 (founder decision, 2026-08-25, taken for the longer
support runway while moving was still free) produced two more:

- **`ADR-0005` again** — PostgreSQL 18 makes `VIRTUAL` the default for generated columns,
  and a virtual column cannot be indexed, so `EXCLUDE USING gist` refuses it. Omitting
  `STORED` now yields a table that builds fine and a constraint that cannot be added. On 17
  it was a syntax error. `STORED` is what holds INV-EFF-002 at enforcement level 2, and
  that is now asserted rather than assumed.
- **`verification/00-roles.sh`** — the teardown called `REASSIGN OWNED` on roles that did
  not exist, so it had never once succeeded on a clean clone. It only worked because the
  Docker volume outlived every run. This is an exit criterion below that was silently
  unmet; wiping the volume for the version change is what exposed it.

Both ADRs are amended and `data-model.md` is corrected.

## Remaining

- [ ] **Neon verification** — the platform half of the ADR lists. The project now exists,
      so this is unblocked and ticketed as POL-001. No fallback preserves the same
      enforcement level if it fails, so this precedes migrations
- [ ] **Repository skeleton** — the monorepo layout from `ADR-0000`, with the
  domain-package
      boundary an architecture test can enforce
- [ ] **Migration harness** — forward-only SQL, three roles, `btree_gist`, the drift check
      (`ADR-0009`)
- [ ] **First migrations** — tenancy, identity, the document spine, the audit ledger
- [ ] **Test harness** — Vitest, integration tests against a Postgres service container,
      `fast-check` for applicability properties. Connecting as `app_role`, never a superuser
- [ ] **CI workflows** — the gate list in `agent-workflow.md`, blocking on every pull
  request
- [ ] **Playwright** — booted in the runner, no deployed environment
- [ ] **Repository governance** — CODEOWNERS with the Tier 2 paths, branch rulesets, the
      issue templates the workflow assumes
- [ ] **Seeds** — reference, development, and test fixtures including the second tenant
  that
      cross-tenant negative tests need

## Exit criteria

- [ ] Every item on every ADR's verification list is checked, or has produced a Decision
      Request
- [ ] `docker compose up -d && ./verification/run.sh` passes from a clean clone
- [ ] The migration chain builds the schema in `data-model.md` on a fresh database, and as
      an upgrade
- [ ] Every level-1 and level-2 constraint carries its invariant ID in a
      `comment on constraint`
- [ ] CI blocks a pull request that breaks a tenant-isolation or authorization test
- [ ] A cross-tenant negative test exists and **fails** when RLS is removed — proving the
      test tests something

## What comes after

| Phase | Output |
|---|---|
| **3 — Golden slice** | The vertical slice as Codex-ready tickets: create → draft → submit → request changes → approve → publish → effective → attest → review → evidence pack |
