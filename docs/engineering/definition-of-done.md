# Definition of Done

A governance feature is not done because the happy path renders. This product's
dangerous defects are failures of **state, authorization, time and evidence**.

A change is done when every applicable row below is satisfied. Rows marked *always*
apply to every change touching application code.

| # | Dimension | Requirement | Applies |
|---|---|---|---|
| 1 | Requirement | Behaviour and acceptance criteria are written down in the issue | always |
| 2 | Domain | State transitions and invariants are explicit and cited by ID | domain changes |
| 3 | Authorization | Both allow and deny paths are tested | any user-reachable path |
| 4 | Tenant isolation | A cross-tenant negative test exists | any data access |
| 5 | Historical behaviour | Effect on point-in-time reconstruction considered and stated | domain changes |
| 6 | Auditability | Required audit event(s) defined, emitted and asserted in a test | governance actions |
| 7 | Privacy | Any new personal-data field is justified; retention class assigned | new data |
| 8 | Failure behaviour | Timeout, duplicate request, race and unavailable-dependency behaviour considered | writes, jobs |
| 9 | Concurrency | Optimistic concurrency or idempotency where two actors can collide | writes |
| 10 | Migration | Schema/data migration validated up **and** on a fresh database | schema changes |
| 11 | Tests | Unit + integration; Playwright where user-visible behaviour is critical | always |
| 12 | Evidence | Effect on evidence packs considered | governance actions |
| 13 | Documentation | `docs/` updated if semantics changed; ADR if architecture changed | as applicable |
| 14 | Review | Independent agent review against the specification, recorded on the PR | tiers 1–2 |
| 15 | CI | All required deterministic checks green | always |

## The spec-drift rule

If a PR changes domain behaviour under `packages/domain/` but changes nothing under
`docs/domain/`, one of two things is true: the documentation is now stale, or the
change was not actually a domain change. CI flags it; the PR must either update the
docs or carry the `no-spec-change` label with a one-line reason.

## Invariant coverage

Every `INV-*` entry in `docs/domain/invariants.md` must be referenced by at least one
test name. CI enforces this. An invariant with no test is a claim, not a guarantee.
