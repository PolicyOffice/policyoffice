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
- [x] **First migrations** — tenancy and identity (POL-006, #34), on a chain applied by its
      documented command (POL-010, #41); the audit ledger (POL-007, #35) and organisation
      (POL-008, #36) both landed 2026-09-02
- [x] **The document spine** — **ticketed 2026-09-02**, once #34 had landed and shown how
      the conventions hold up. It wanted more than two tickets; it got eight, every one
      Tier 2. **Seven of the eight have landed; status as at 2026-09-07:**

  | Ticket | What | Status |
  |---|---|---|
  | POL-011 (#49) | `configuration_version`, `document_type`, `information_classification` | **merged** #62 |
  | POL-012 (#50) | `document` and `document_variant`, and the one-baseline guarantee | **merged** #69 |
  | POL-013 (#51) | `document_version`, the INV-EFF-002 exclusion constraint, the INV-VER-003/007 immutability triggers | **merged** #73 |
  | POL-014 (#52) | `content_revision` and `content_attachment` | **merged** #79 |
  | POL-015 (#53) | Canonicalisation and the content digest | **merged** #71 |
  | POL-016 (#54) | The publication transaction, where INV-EFF-003's atomicity actually lives | ready |
  | POL-017 (#55) | The effective-instant transition, which only narrates what publication decided | blocked on #54 |
  | POL-018 (#56) | `applicability_rule` and `alignment_obligation` — tables only; resolution is V1 | ready |

  All three forward references are **resolved**: `document_type.mandated_by_document_version_id`
  (POL-011 → POL-013), `document_version.approved_revision_id` (POL-013 → POL-014, created
  nullable and still unbound until the approval ticket), and INV-DOC-008's retirement trigger
  (POL-012 → POL-013).

  **Four tickets the plan did not anticipate came out of building it**, which is the honest
  measure of how good the original decomposition was — the spine was right, the enforcement
  around it was not:

  | Ticket | Why it exists |
  |---|---|
  | POL-019 (#68) | **merged** #74. An implemented audit event left on the shared `ENVELOPE_ONLY_SCHEMA` placeholder passed every check while carrying no state. Caught by hand in POL-011's review, nearly repeated in POL-012, now a build failure |
  | POL-020 (#70) | ready. `body_membership` was deletable while `org_membership` was not, and INV-ORG-002's rationale needs the seat history. Decision Request #66 |
  | POL-021 (#75) | **merged** #77. `document_version.lifecycle_state` had no transition guard at all: any state to any state, and a row insertable straight into `EFFECTIVE` |
  | — | Five Decision Requests (#72, #76, #78, #81, and #66) settled rules the specification implied but never stated. Four were defects in tickets rather than in the specification |

- [ ] **Playwright** — booted in the runner, **carried to Phase 3**. There is nothing to
      point it at: `apps/web` contains exactly one route, `/health`. A browser test suite
      against no interface is ceremony, and it arrives with the first screens
- [x] **Repository governance** — CODEOWNERS carries the Tier 2 paths, the issue templates
      exist, and the branch ruleset is **applied** (2026-08-31): thirteen required checks,
      squash-only, linear history, no force-push, no deletion. A direct push to `main` is
      rejected. Secret scanning, push protection and the dependency graph are enabled.
      `allow_update_branch` was enabled 2026-09-04: auto-merge now updates a stale branch
      itself, though the head sha it produces still costs the pull request a re-review
- [x] **Seeds** — POL-009 (#37), merged 2026-09-03. Reference values stay migration-owned
      enum labels; development and test fixtures load through `app_role` under a
      transaction-local tenant context, never as a superuser. The **second tenant** exists,
      and a schema-discovered test fails when a tenant-owned table is added without a row for
      both test tenants — so the guarantee cannot decay silently. The only audit history the
      loaders create is one genuine `configuration.changed` per fixture tenant; nothing is
      backfilled

## Exit criteria

- [ ] Every item on every ADR's verification list is checked, or has produced a Decision
      Request — **one outstanding, carried forward**: Neon restore timing, which needs a Neon
      API key. `ADR-0009` wants a measured number so the disaster-recovery claim is not an
      assumption; Neon restores by branching to a past instant, a control-plane operation that
      a connection string cannot reach. **Deliberately not done now**: the claim is made to
      nobody yet, there is no deployment and no customer data. **The trigger is the first real
      data** — measure it before any production data exists, not before Phase 2 closes
- [x] `docker compose up -d && ./verification/run.sh` passes from a clean clone — verified
      2026-08-25 from a destroyed volume, having never actually held before
- [x] The migration chain builds the schema in `data-model.md` on a fresh database, and as
      an upgrade — `pnpm db:verify` covers fresh, upgrade-with-data and Drizzle drift, and has
      passed on every migration through `0011`
- [x] Every level-1 and level-2 constraint carries its invariant ID in a
      `comment on constraint` — met by POL-022 (#93). One gate now discovers all governed
      constraints from PostgreSQL's catalogue and requires an invariant ID or an explicit,
      constraint-specific exception when no registered invariant exists
- [ ] CI blocks a pull request that breaks a tenant-isolation or authorization test — the
      tenant-isolation gate is live; **the authorization matrix is carried to Phase 3** because
      it cannot exist before the `ADR-0003` evaluator does. Every ticket in this phase recorded
      the capability its entry points require and deferred enforcement to that evaluator; those
      recorded contracts are what the matrix will be built from
- [x] A cross-tenant negative test exists and **fails** when RLS is removed — proving the
      test tests something


## Phase 2 is closed

**Closed 2026-09-08.** A ticket can be implemented, tested and merged without anyone setting
anything up by hand, which is what this phase existed to prove.

Fourteen migrations build the schema from nothing and as an upgrade with data. The document
spine is complete end to end — a document and its baseline variant, versions with an
exclusion-constrained effectivity interval, governed content revisions with a byte-exact
canonical digest, publication, supersession, the effective instant and withdrawal. Twelve
deterministic CI checks plus an independent review gate every pull request, and `main` is
protected against everything including its own maintainers.

**Three exit criteria are carried forward rather than met, each with its reason and its
trigger recorded above**: Neon restore timing needs an API key and is not needed until real
data exists; Playwright needs an interface that does not exist yet; the authorization matrix
needs the `ADR-0003` evaluator, which every ticket in this phase deliberately deferred.

The former partial constraint-comment criterion is now met by a schema-discovered gate; it
does not depend on a ticket author remembering to extend a constraint-name allowlist.

### What building it taught, which the plan did not predict

Three tickets exist that were never planned — POL-019, POL-020 and POL-021 — and every one
covers **enforcement that was missing around a spine that was otherwise decomposed correctly**.
An audit event could be implemented while carrying no state; `body_membership` was deletable
while `org_membership` was not; `document_version.lifecycle_state` had no transition guard at
all, so a row could be inserted straight into `EFFECTIVE`. The tables were right and the
things stopping them being misused were not.

Seven Decision Requests were raised. **One was a genuine product question** — whether
INV-ORG-002 covers governance-body membership. **Five were defects in tickets rather than in
the specification**, all of the same shape: a ticket asserted what another artefact contained
instead of opening it. That is now a rule in `CLAUDE.md`. **One was a specification gap found
late** — applicability rules are specified on the variant while applicability scope is
immutable from approval and corrected by a new version, which cannot all hold. POL-018 (#56)
is deferred until Phase 3 settles it.

Every one of the seven was caught before implementation. The two-agent split is doing the work
it was built for, and the measurable cost of a bad ticket is one round trip rather than one bad
migration.

## What comes after

| Phase | Output |
|---|---|
| **3 — Golden slice** | `phase-3-golden-slice.md`. The vertical slice as Codex-ready tickets, and the four things that must be decided before most of them can be written |
