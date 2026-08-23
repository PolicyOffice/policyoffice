Closes #

## What changed

<!-- One paragraph. What behaviour is different now? -->

## Risk tier

<!-- 0 = docs/config/deps · 1 = ordinary feature code · 2 = authorization, tenancy,
     versioning, effectivity, approval, audit, evidence, content hashing -->

- [ ] Tier 0
- [ ] Tier 1
- [ ] Tier 2

## Invariants

<!-- IDs from docs/domain/invariants.md that this change touches or relies on,
     and the test that proves each. Write "none" only for tier 0. -->

## Audit events

<!-- Events emitted or changed, and the test asserting them. "none" if not applicable. -->

## Checks

- [ ] Acceptance criteria in the linked issue are all satisfied
- [ ] Tenant-isolation negative case covered (or not applicable — say why)
- [ ] Authorization allow **and** deny paths tested (or not applicable — say why)
- [ ] Historical / point-in-time behaviour considered
- [ ] Migration validated on a fresh database **and** as an upgrade (or none)
- [ ] `docs/` updated if semantics changed — or `no-spec-change` label with a reason
- [ ] No new personal-data field without justification below

## Notes for the reviewer

<!-- Anything non-obvious: a trade-off taken, a rejected alternative, a follow-up.
     If you had to make a judgement call the ticket did not cover, say so here —
     or open a Decision Request instead if it changes a product rule. -->
