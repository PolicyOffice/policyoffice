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
- [x] **Neon verification** — `verification/neon.sh`, 24 assertions against the
      provisioned project. `ADR-0001`'s load-bearing claim **holds**: a non-owner role with
      `FORCE ROW LEVEL SECURITY` binds, so INV-TEN-001 stays at enforcement level 2 and no
      Decision Request is needed. Four findings amended `ADR-0000`, `ADR-0001` and
      `ADR-0009`; detail in `verification/README.md`. One item is still outstanding —
      restore timing needs a Neon API key

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

Then Neon produced four more, two of which changed how migrations must be written:

- **`ADR-0001`** — Neon's provisioned role `neondb_owner` holds `BYPASSRLS`. Connect the
  application with the credentials the platform hands you and tenant isolation is silently
  unenforced while every test passes. The three explicit roles are the only thing preventing
  it.
- **`ADR-0009`** — the pooled endpoint caches server connections by role **OID**, so
  dropping and recreating a role under the same name serves `invalid role OID` and spurious
  permission errors until connections cycle. Roles are created once and `ALTER`ed, never
  recreated.
- **`ADR-0009`** — `CREATE INDEX CONCURRENTLY` works through the pooler. The ADR predicted
  it would need a direct connection.
- **`ADR-0001`** — both endpoints fail closed with no tenant context, but with *different*
  errors. No code path may detect missing tenant context by matching on the error.

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


- [x] **Repository skeleton** — pnpm workspaces, `packages/domain` framework-free with the
      boundary enforced by an allowlist architecture test, Node 24, TypeScript strict
- [x] **Migration harness** — forward-only SQL with per-file checksums, the three roles,
      `btree_gist`, non-transactional migrations, session timeouts, and the fresh/upgrade/
      drift checks. No down-migration path exists
- [ ] **First migrations** — tenancy, identity, the document spine, the audit ledger
- [x] **Test harness** — Vitest with unit/integration/property projects, `fast-check`, and
      the invariant coverage gate. Connects as `app_role`; a test citing a tenancy or
      authorization invariant while holding a privileged connection fails
- [x] **CI workflows** — the gate list, blocking on every pull request, with every gate's
      status recorded in `docs/engineering/ci-gates.md`. Gates whose subject does not exist
      yet are listed there as pending rather than created as jobs that pass trivially. Two
      steps need repository-admin scope and are the founder's to run: the branch ruleset and
      secret-scanning push protection
- [ ] **Playwright** — booted in the runner, no deployed environment
- [~] **Repository governance** — CODEOWNERS carries the Tier 2 paths and the issue
      templates exist. The branch ruleset is committed as `.github/rulesets/main.json` and
      needs one founder command to apply
- [ ] **Seeds** — reference, development, and test fixtures including the second tenant
  that
      cross-tenant negative tests need

## Exit criteria

- [ ] Every item on every ADR's verification list is checked, or has produced a Decision
      Request — **one outstanding**: Neon restore timing, which needs a Neon API key
- [x] `docker compose up -d && ./verification/run.sh` passes from a clean clone — verified
      2026-08-25 from a destroyed volume, having never actually held before
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
