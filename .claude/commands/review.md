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
5. **Verify the claims rather than reading them.** A PR summary states what was done; a
   review establishes whether it is true. Check the things that would be expensive to get
   wrong — that an applied migration's checksum still matches, that a constraint actually
   refuses what it claims to refuse, that a test fails when the thing it guards is removed.
   Run them. This is the difference between a review and a proofread.
6. Post the review as a **pull request comment**, citing invariant IDs in every finding.
   Not `gh pr review` — GitHub refuses `--approve` and `--request-changes` on a pull
   request opened by the same account, and both agents authenticate as the founder's.
   `CONTRIBUTING.md` explains why this repository will not create a second account to work
   around that.
7. **When, and only when, the diff is correct**, end the comment with:

   ```text
   Reviewed-commit: <the full 40-character head sha>
   ```

   That sets the `independent review` status and is what makes the pull request mergeable.
   Fetch the sha fresh — it changes on every push, and a stale one leaves the status
   pending with no visible cause.

**Never post `Reviewed-commit:` on a pull request you authored.** `AGENTS.md` rule 8. It
would unblock your own merge and defeat the only condition a machine cannot check.

If a PR contradicts a rule in `docs/domain/`, do not suggest a workaround — say so plainly
and add the `decision-required` label.

Report a one-line verdict per PR when done, and hand the operator both commands they need:
the `Reviewed-commit` comment if you are approving, and `gh pr merge <n> --squash
--delete-branch`. Check `mergeStateStatus` is `CLEAN` first, so you are not handing over a
command that will bounce.
