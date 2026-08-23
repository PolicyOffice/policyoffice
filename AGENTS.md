# AGENTS.md

Read this first. It is a **map**, not the specification. It tells you where authority
lives and which rules you may not break. It is deliberately short.

## What this is

A Policy Operations platform: a system of record for controlled policy lifecycle —
authoring, approval, publication, applicability, distribution, attestation, review,
audit and evidence — for regulated European companies.

It is **not** a wiki, a document store, or a GRC suite.

The guiding test for any change:

> Does this make the system better able to prove which policy version governed whom,
> at what time, under what authority, and with what evidence?

## Where authority lives

| Question | Authoritative source |
|---|---|
| What the product does and for whom | `docs/product/` |
| Domain concepts, states, rules | `docs/domain/` |
| **Invariants you must never break** | `docs/domain/invariants.md` |
| Why the architecture is the way it is | `docs/architecture/adr/` |
| How we work, review and merge | `docs/engineering/agent-workflow.md` |
| When a change counts as finished | `docs/engineering/definition-of-done.md` |
| The current ticket you are implementing | its GitHub issue |

If a GitHub issue and the spec disagree, **the spec wins** — stop and open a
Decision Request.

## Non-negotiable rules

1. **Never silently change a product rule.** If implementing a ticket seems to require
   contradicting `docs/domain/`, stop and open a Decision Request. Implementation
   convenience never overrides governance semantics.
2. **Invariants are cited, not remembered.** Every invariant has a stable ID
   (`INV-VER-003`). Tickets cite them; test names contain them. If you add or change a
   domain rule, the registry entry and its tests change in the same PR.
3. **Released policy content is immutable.** No code path may mutate an approved,
   published or effective version's normative content.
4. **Tenant isolation is absolute.** Every query is tenant-scoped below the UI layer.
   A cross-tenant identifier behaves as not-found, never as forbidden-with-metadata.
5. **Automation never invents authority.** Nothing auto-approves on timeout. An overdue
   review never invalidates an effective policy. Ambiguity fails closed.
6. **The product runs without an LLM.** No runtime AI dependency in any domain
   operation: applicability, authorization, approval, effectivity, attestation,
   audit or evidence.
7. **Privacy is minimal by default.** Do not collect personal data because "an auditor
   might want it." New personal-data fields require justification in the PR.

## Working rules

- Branch: `feat/pol-142-short-slug`, `fix/…`, `docs/…`, `chore/…`
- Commits: [Conventional Commits](https://www.conventionalcommits.org/). Imperative mood.
- One PR closes exactly one issue (`Closes #142`). Small and coherent.
- Squash merge only. Branch deleted on merge. `main` is always releasable.
- Never commit secrets, `.env`, or Playwright auth state.
- Agent authorship is attributed honestly in commit trailers. That is a feature of this
  project, not something to hide.

## Escalate, do not improvise

Open a **Decision Request** issue (template provided) and stop, when you hit:

- a new paid service or a free tier that will be exceeded;
- scope that cannot be built as specified;
- anything that would change a rule in `docs/domain/`;
- a new category of personal data, a retention change, or a new subprocessor;
- anything irreversible or externally visible;
- a disagreement between agents that tests cannot settle.

A blocked ticket with a clear question is a good outcome. A ticket that quietly
redefined the product is not.

## Agent lanes

| Agent | Owns |
|---|---|
| **Claude Code** | Specification, ADRs, ticket authoring, architecture, hard debugging, PR review |
| **Codex** | Implementation, tests, CI fixes, responding to review comments |
| **CI** | The merge gate. Deterministic. No AI in the required-check path. |
| **Founder** | Product decisions, milestone acceptance |

Reviewer must never be the implementer.
