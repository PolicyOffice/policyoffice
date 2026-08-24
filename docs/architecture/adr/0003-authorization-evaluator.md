# ADR-0003: The authorization evaluator

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

> **INV-AUTH-001 — Default deny: absent an applicable grant, access is refused.**

The invariant registry targets this at **level 4** — *one evaluator; no code path that
answers authorization independently* — and explicitly notes it cannot go higher. Unlike
tenancy, there is no database constraint that expresses "this principal may approve this
document". It is application logic, and the only thing standing between it and the classic
failure is that there must be exactly one implementation and every surface must be unable
to avoid it.

That word *unable* is what this ADR is about. `authorization-model.md` specifies the
decision; this specifies the machinery that makes bypassing it awkward enough that it does
not happen by accident.

Nine invariants depend on it: INV-AUTH-001 through 004, 008, 010, 011, and INV-TEN-002 and
INV-TEN-004.

## Decision

### One function, one shape

```ts
decide(ctx: AuthzContext, capability: Capability, resource: ResourceRef): Decision
```

`Decision` is not a boolean. It carries the outcome **and the reason**:

```ts
type Decision =
  | { allowed: true;  via: GrantRef }
  | { allowed: false; because: 'NO_GRANT' | 'EXPLICIT_DENY' | 'EXPIRED'
                             | 'PRINCIPAL_INACTIVE' | 'WRONG_TENANT' }
```

Two things fall out of returning a reason rather than a boolean.

`information-architecture.md` requires that *"why does this apply to me"* is answerable in
one click, and administrators need the same for access: *why can this person see this?* A
boolean cannot answer it, and reconstructing the answer separately means a second
implementation of the rules — which is the thing this ADR exists to prevent.

And `WRONG_TENANT` never reaches a response. It maps to not-found, with the same shape and
comparable timing as a genuinely absent resource (INV-TEN-002, INV-TEN-005). Keeping it
distinct *inside* the evaluator while collapsing it *at the boundary* is deliberate: the
distinction is useful for tests and telemetry and must never be useful to an attacker.

### Capabilities are types, not strings

```ts
type Capability = 'document.read' | 'document.approve' | /* … the closed set … */
```

A misspelled capability fails to compile rather than silently matching no grant
(INV-AUTH-016). This is the enforcement ladder's level 3, and it is most of the reason
`ADR-0000` chose a typed language.

### Nothing reaches data without a context

The rule from ADR-0001 — one transaction helper, requiring a tenant context — extends
here: that context also carries the principal, and repository functions require it. There
is no ambient current-user, no module-level client, and no way to load a document without
having said on whose behalf.

Enforced by an architecture test that fails the build if anything outside the data layer
imports the database client, and if any repository function is reachable without a context
argument. Convention would not survive an agent implementing forty tickets.

### Where the decision happens

| Surface | How |
|---|---|
| Server actions and route handlers | `decide` before the domain call. The domain assumes an authorised caller |
| Background jobs | Run as an explicit principal with explicit capabilities. No system-user-with-everything (INV-TEN-004) |
| Search | At **retrieval**, over candidate rows, never by trusting index filtering (INV-AUTH-011). Counts and facets are computed after filtering (INV-AUTH-012) |
| Evidence packs | Each included record is checked as it is assembled, bounding the pack by the requester's capabilities at request time (INV-EVD-010) |
| Public API and webhooks | The same function. Identical to the UI by construction, not by discipline (INV-AUTH-010) |

Search and evidence are the two that products in this category get wrong, and both are
listed here so the ticket that implements them has no excuse.

### Caching: within one request, never across

> **INV-AUTH-003 — A grant with a validity interval stops authorising at expiry, evaluated
> during the authorization check itself.**

The evaluator memoises within a single request or job, and discards it at the boundary.
Nothing is cached across requests, in a session, or in a materialised permission table. A
cache that outlives a grant is an access-control failure (INV-AUTH-004), and a
materialised permissions table is such a cache with better performance and worse honesty.

Requests are therefore expected to be short. If one ever runs long enough for
expiry-within- a-request to matter — a large evidence pack — the evaluation is re-done per
included record, which the assembly loop does anyway.

### Deny beats allow, evaluated in one pass

The algorithm is `authorization-model.md`'s, unchanged: collect grants for the principal
and their groups, valid at this instant, at any scope containing the resource; any `DENY`
matching the capability refuses; otherwise any `ALLOW` permits; otherwise refuse.
Specificity never enters into it (INV-AUTH-002).

Scope containment follows the administrative chain — owning org unit, legal entity, tenant
— and never applicability (INV-AUTH-017). `SPACE` is not a scope type and is not accepted
by the signature (INV-AUTH-015).

### Proving it

An **authorization matrix test** enumerates the cross product of system role, capability,
scope relationship and grant validity, and asserts the expected decision for every cell.
It is generated from the role table in `authorization-model.md`, so adding a capability
without deciding which roles hold it fails the build rather than defaulting to nobody —
or, worse, to everybody.

The CI gate list already names this suite as blocking on every pull request.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Middleware-only enforcement** | Protects routes, not data. Background jobs, search retrieval and evidence assembly all bypass it, and those are precisely where this category leaks |
| **Policy engine — OPA, Cedar, or similar** | A real, well-tested implementation of exactly this. It also adds a language, a deployment component and a second place the rules live, for a rule set that fits on one page. Revisit if tenant-authored policies ever appear |
| **Database-enforced permissions** | Postgres grants are per-role, not per-row-per-principal, and RLS policies over grant tables would put the entire evaluator in SQL where it is far harder to test and explain |
| **Materialised effective-permissions table** | Fast, and it is a cache that outlives entitlements. INV-AUTH-003 and INV-AUTH-004 rule it out |
| **Boolean return** | Cannot answer *why*, so the explanation gets implemented twice |
| **Capability strings** | A typo becomes a silent deny — or, with a permissive matcher, a silent allow |

## Consequences

### What becomes easier

- One place to read, review and test the most security-critical logic in the product.
- Explaining an access decision to an administrator is a feature of the mechanism rather
  than a reporting project.
- Adding a surface — an API, a webhook, an export — cannot accidentally skip
  authorization, because it cannot reach data without a context.

### What becomes harder

- **Context threading is verbose.** Every repository call takes a context argument. This
  is the visible cost, it will be tempting to smuggle in an ambient accessor, and the
  architecture test exists to stop that.
- **No cross-request caching** means the evaluator runs on every check. It is a small
  indexed query and it must stay that way; if it ever becomes a performance problem, the
  answer is a better query, not a longer-lived cache.
- **The matrix test grows** with every capability and role. That is the point, and it is
  also real maintenance.

### What we have committed to maintaining

- Exactly one implementation. The second one, however small and however justified, is the
  defect this ADR exists to prevent.
- The architecture test that makes the boundary real.

### Cost of reversing this

Low to moderate. Behind one function, so swapping the implementation — for a policy
engine, say — touches the evaluator and its tests. What would be expensive is *relaxing*
the boundary, because permitting a second path means auditing every call site to find
which one was used.

## To verify at repository bootstrap

- That an architecture test can actually enforce the import boundary in the chosen
  tooling, and fails the build rather than warning.
- The evaluator's query cost with the grant tables under ADR-0001's RLS policy, since it
  runs on every check.
- That the matrix test can be generated from the role table rather than hand-maintained,
  which is what makes it hold as the capability set grows.
