---
description: Review every open pull request against the specification
---

List open pull requests with `gh pr list --state open`. For each one that has no review
from you since its most recent commit:

1. Read the linked issue and the specification sections it cites.
2. Read the diff.
3. Review against `CLAUDE.md` — the ticket's acceptance criteria, invariant IDs, audit
   events, authorization on every entry point including background jobs, tenant scoping,
   historical behaviour, and whether the required tests actually test the invariant they
   name. Style is the linter's job, not yours.
4. Match depth to the risk tier declared in the PR body. Tier 0 needs nothing from you.
5. Post the review with `gh pr review`. Cite invariant IDs in every finding.

If a PR contradicts a rule in `docs/domain/`, do not suggest a workaround — say so plainly
and add the `decision-required` label.

Report a one-line verdict per PR when done.
