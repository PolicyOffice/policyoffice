# CI gates

`agent-workflow.md` § *CI gates* lists what blocks a merge. This file records, for each of
them, whether it actually exists — because the failure mode being designed against is a
gate that is quietly absent, and the second-worst is a gate that passes trivially because
its subject does not exist yet.

**No job in this list may pass by having nothing to do.** A green check that tested nothing
is worse than a missing one: the missing one is visible here, and the green one is not
visible anywhere.

**No AI in the required-check path.** Nothing in `.github/workflows/pr.yml` calls a model,
an API or any non-deterministic service. The one deliberate exception is the
independent-review check, which records that a review happened and is not a correctness
gate — see `CONTRIBUTING.md`.

## On every pull request

| Gate | Status | Where |
|---|---|---|
| locked dependency install | **live** | `.github/actions/setup` — `pnpm install --frozen-lockfile` |
| format | **live** | `pr.yml` → `format` |
| lint | **live** | `pr.yml` → `lint` |
| typecheck | **live** | `pr.yml` → `typecheck` |
| unit tests | **live** | `pr.yml` → `unit` |
| domain invariant tests | **live** | `pr.yml` → `invariants` |
| integration tests (real Postgres) | **live** | `pr.yml` → `integration`, service container, connecting as `app_role` |
| migration validation: fresh **and** upgrade | **live** | `pr.yml` → `migrations`, plus the drift check |
| tenant-isolation suite | **live** | `pr.yml` → `tenant-isolation`, schema-discovered forced RLS and cross-tenant negatives |
| authorization matrix | *pending* | no authorization evaluator exists |
| audit-event completeness | **live** | `pr.yml` → `audit-events`; catalogue, versioned registry and the sole insertion path stay in step |
| production build | **live** | `pr.yml` → `build` |
| dependency review | **live** | `pr.yml` → `dependency-review` |
| secret scanning + push protection | **live** | repository setting, enabled 2026-08-30 |
| CodeQL | **live** | `codeql.yml` |
| Playwright critical suite (Chromium) | *pending* | there is no user-visible surface to drive |

## Scheduled

| Gate | Status | Where |
|---|---|---|
| Neon platform re-verification | **live** | `neon-verification.yml`, weekly. Needs two secrets |
| CodeQL, full query set | **live** | `codeql.yml`, weekly |
| full Chromium + Firefox + WebKit | *pending* | with Playwright |
| property-based applicability resolution | *partly* | the `property` project runs; the applicability tests need a resolver (INV-APL-001) |
| backup-restore drill | *pending* | needs a Neon API key; the restore-timing item is still open on `ADR-0009` |

## The ordering rule: add the job, merge it, then require it

A required status check may enter the **applied** ruleset only once its job exists on
`main`. Never from the branch that introduces it.

The reason, learned the hard way on 2026-08-31: a check was added to the applied ruleset
while its job existed only on one feature branch. Every *other* open pull request became
permanently unmergeable, because a status nothing would ever report was required of them.
The gate looked correct and the repository was deadlocked.

So the sequence is:

1. add the job to `pr.yml` **and** the context to `.github/rulesets/main.json`, in the same
   pull request — `tooling/ci-gates.test.ts` fails if they disagree;
2. merge it;
3. re-apply the ruleset **from `main`**, where the job now exists.

Between 2 and 3 the committed file and the applied ruleset differ by one context. That gap
is deliberate and is the safe direction: a check that exists but is not yet required blocks
nobody, while a check that is required but does not exist blocks everybody.

**Applying the ruleset is not an implementing agent's job.** It is live configuration, it
takes effect immediately for everyone, and it is not reviewable as a diff — `AGENTS.md`
lists it under *Escalate, do not improvise*. Change the file in your pull request; someone
else applies it afterwards, in the order above.

## Each pending gate arrives with the code it protects

Not as a follow-up ticket, and not as a placeholder job. The pull request that adds an
authorization evaluator adds the authorization matrix in the same diff, and moves its row
here from *pending* to **live**. That way the gate cannot lag the capability it exists to
constrain.

## Repository settings, applied

These are not expressible as workflow files. Applied 2026-08-30:

- **Dependency graph** — `PUT /repos/:owner/:repo/vulnerability-alerts`. The dependency
  review gate fails without it, which is how its absence was noticed.
- **Auto-merge and delete-branch-on-merge** — enabled 2026-09-01. A pull request merges
  when its last required check passes and removes its own branch. Auto-merge is not a
  bypass: it waits for *every* required check, `independent review` included.
- **Secret scanning and push protection** — push protection is the one that matters: it
  rejects a commit containing a recognised credential before it reaches the remote rather
  than alerting afterwards. On a public repository, "afterwards" means already published.

## Dependency overrides

`package.json` carries a `pnpm.overrides` block. `package.json` cannot hold comments, so
the reasoning lives here.

| Override | Why |
|---|---|
| `esbuild: >=0.25.0` | esbuild ≤ 0.24.2 lets any website send requests to the development server and read the response. It arrived transitively through `@esbuild-kit/*`, which `drizzle-kit` still depends on although those packages are deprecated in favour of `tsx`. Exposure was small — a dev-only tool — but the fix is one line, the dependency-review gate fails on moderate severity, and *"we assessed the exposure as low"* is a worse answer than *"we patched it"* for a product whose proposition is trustworthiness. Found the moment the dependency graph was enabled. |

Remove an override when the upstream dependency no longer needs it. An override that has
outlived its reason is a pin nobody remembers making.

## The branch ruleset for `main`

**Applied 2026-08-31.** Committed as `.github/rulesets/main.json` and active: a direct push
to `main` is rejected, thirteen checks are required, merges are squash-only, history is
linear, and the branch cannot be force-pushed or deleted.

Re-apply after editing the file with:

```bash
gh api -X POST repos/PolicyOffice/policyoffice/rulesets --input .github/rulesets/main.json
```

It requires the gate jobs to pass, forbids force-pushes and deletion, and enforces linear
history with squash-only merges.

**It deliberately does not require review from Code Owners.** The only code owner is the
founder, and `agent-workflow.md`'s merge policy is explicitly that nobody clicks anything.
Requiring code-owner approval would deadlock every Tier 2 pull request on the one person
the workflow exists to keep out of the loop. `.github/CODEOWNERS` says the same thing where
someone would look for it.

## Secrets for the scheduled Neon job

```bash
gh secret set NEON_DATABASE_URL_POOLED
gh secret set NEON_DATABASE_URL_DIRECT
```

Paste each connection string when prompted. They are used **only** by
`neon-verification.yml`, never by a workflow a pull request can trigger.
