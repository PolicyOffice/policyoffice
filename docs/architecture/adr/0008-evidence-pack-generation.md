# ADR-0008: Evidence pack generation

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

The evidence pack is the product's primary output when someone external asks the
organisation to prove something. `evidence-model.md` specifies what a pack contains and
what must be true of it; this ADR decides how it is assembled.

Four invariants shape the mechanism:

> **INV-EVD-004 — A partially generated pack is marked failed and never made available as
> complete.**  **INV-EVD-006 — Regenerating a pack for the same specification yields the
> same substantive records; only packaging metadata may differ.**  **INV-EVD-010 — A pack
> never contains records the requester was not authorised to read at request time.**
> **INV-EVD-003 — Every file in a pack validates against its recorded digest.**

## Decision

### A job, in three phases

Generation runs on the job runner from `ADR-0007`, and is structured so that the decisions
a pack embodies are made *before* any bytes are written.

```text
Phase 1 — Resolve      as-of state: versions, memberships, audience, grants,
                       configuration versions, workflow template versions,
                       and the audit sequence range.
                       Record the resolved object list.

Phase 2 — Assemble     stream each file to a staging prefix, computing its
                       digest as it streams. Write manifest.json and
                       integrity/SHA256SUMS last.

Phase 3 — Publish      one transaction: record manifest_digest, storage_ref
                       and status = AVAILABLE, and emit
                       evidence_pack.generated.
```

Phase 1 exists because a pack is a set of decisions before it is a set of files. Resolving
first — and recording the resolved list in the manifest — means the pack states what it
decided to include, and the assembly phase has nothing left to interpret.

### Availability is a database row, not the presence of an object

The one thing INV-EVD-004 forbids is a partial pack presented as complete, and the classic
way that happens is a consumer discovering a half-written object in storage.

So the object's existence never signals availability. Files are written to a staging
prefix; the pack becomes downloadable only when phase 3 commits `status = AVAILABLE` in
Postgres, and every download path checks that row. A failure at any point leaves `status =
FAILED` (or `GENERATING` for a crashed worker, which the retry policy resolves), and
staging objects are swept by a later job.

### Determinism: the records, not the bytes

INV-EVD-006 says *substantive records*, and that wording is doing useful work. Chasing a
byte-identical ZIP is a rabbit hole — archive metadata, compression levels and library
versions all leak in — and the invariant deliberately does not require it.

What is made deterministic:

| Artefact | Rule |
|---|---|
| Audit slice | Ordered by `(occurred_at, sequence)`, bounded by an explicit sequence range recorded in the manifest. `ADR-0006`'s gapless commit-ordered sequence is what makes this stable |
| CSV | Fixed column order, UTF-8, LF endings, RFC 4180 quoting applied uniformly, rows sorted by a declared stable key |
| JSON and JSONL | Same canonical serialisation as `ADR-0004` — sorted keys, no insignificant whitespace |
| Object list | Sorted by type then identifier |
| Queries | Every one bounded by `as_of`; none reads mutable current state |

What is permitted to differ: `packId`, `generatedAt`, archive entry timestamps and
compression. All packaging, all recorded in the manifest, none of it substantive.

As a cheap extra, ZIP entries are written in a fixed order with normalised timestamps.
That gets close to byte-identical without depending on it, which is the right side of that
line.

### Authorization is applied per record, at assembly

> **INV-EVD-010 — A pack never contains records the requester was not authorised to read
> at request time.**

Every candidate record passes through `ADR-0003`'s evaluator with the **requester's**
principal, at the instant of the request. Evidence generation must not become a privilege
escalation path, and the way to guarantee that is to make it use the same function every
other read uses.

Where records are excluded, the manifest records them:

```json
"exclusions": [
  { "type": "DOCUMENT_VERSION", "id": "…", "reason": "REQUESTER_NOT_AUTHORISED" }
]
```

A truthful partial pack, clearly labelled, rather than a silent omission or an
unauthorised disclosure. `evidence-model.md` already specifies this field.

Privacy profiles are applied **in the queries**, not by filtering assembled output. A
`MINIMAL` pack never loads individual-level personal data in the first place, which is
what minimisation means in practice.

### Streaming, not buffering

Packs can reach hundreds of megabytes once original controlled files are included.
Assembly streams each file from object storage into a ZIP stream and out via multipart
upload, computing digests in flight. The application never holds a pack in memory.

The manifest is written last, because it contains every file's digest. It cannot contain
its own, so `manifest_digest` is recorded on the database row — which is also what a
verifier compares against when checking that a downloaded pack is the one that was
generated.

### Downloads expire, checked at retrieval

> **INV-EVD-008 — Pack download links expire, and expiry is enforced at retrieval.**

No long-lived URL is ever issued. A download request checks `download_expires_at` on the
row and the requester's capability, then mints a short-lived single-use signed URL. The
same rule as expiring grants in `ADR-0003`: enforced at the check, not by a sweep job.

Every request, generation, failure and download emits an event (INV-EVD-005). Evidence
access is itself evidence.

### Renderings — an honest gap

`evidence-model.md` specifies `document/document.pdf`, a human-readable rendering,
alongside `document/original/`.

With file-centric content (decision 2), that is free when the controlled file is already a
PDF and expensive otherwise: converting `.docx` faithfully needs LibreOffice or an
equivalent in the deployment, which is real operational weight and, on any managed
platform, real money.

For the Pilot this ADR does **not** decide it. Where a rendering cannot be produced, the
manifest records `document.pdf` as absent with a reason, and the original file is always
present. That is a divergence from the layout in `evidence-model.md`, so it is escalated
rather than absorbed: **open decision 9**, in `docs/plans/open-decisions.md`.

Recording it that way is the point of the rule in `AGENTS.md` — an architecture phase that
quietly narrows a specified deliverable has redefined the product without telling anyone.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Synchronous generation on request** | A pack can take minutes. It also makes the web process hold large streams, which is what `ADR-0000`'s worker split avoids |
| **Object presence as the availability signal** | The precise failure INV-EVD-004 forbids — a consumer finding a half-written archive |
| **Byte-identical archives** | A rabbit hole the invariant explicitly does not require, and one that would make a library upgrade an evidence incident |
| **Assemble in memory** | Fails on the packs that matter most, and does so in production rather than in tests |
| **Post-filtering assembled output for privacy profiles** | Loads the personal data in order to remove it. Minimisation means not loading it |
| **A pack-generation service role with broad read access** | Faster, and it makes evidence generation a privilege-escalation path. INV-EVD-010 exists to forbid exactly this |
| **Long-lived public download URLs** | Packs concentrate personal data. INV-EVD-008 |
| **Deciding the rendering question here** | It costs money and narrows a specified deliverable. That is a Decision Request, not an architecture call |

## Consequences

### What becomes easier

- A verifier needs only a hash utility: digests are in the manifest, the manifest's digest
  is on the row, and nothing has to be recomputed by application code.
- Point-in-time packs are the same pipeline with a different `as_of`, because every query
  is already bounded by it.
- Regeneration produces the same substantive records, which is what makes the artefact
  evidence rather than a report.

### What becomes harder

- **Three phases and a staging area** is more machinery than writing a ZIP.
- **Per-record authorization at assembly** costs an evaluator call per included record.
  Large packs will feel it, and the fix is a better evaluator query, never a bulk bypass.
- **Sweeping staging objects** is another scheduled job with its own failure mode.
- **The rendering gap is visible in output** until decision 9 is answered, and a customer
  will notice a missing `document.pdf` before we do.

### What we have committed to maintaining

- Availability as a database fact, never as the existence of an object.
- The requester's principal through every assembly query. No service-role shortcut, ever.
- Canonical serialisation shared with `ADR-0004`, so a digest means the same thing
  everywhere.

### Cost of reversing this

Low. The pipeline is behind a job handler, and the output format is specified in
`evidence-model.md` rather than here. What would be expensive is relaxing INV-EVD-010,
since packs already issued would have been assembled under the looser rule.

## To verify at repository bootstrap

- Multipart upload and streaming ZIP against the chosen object storage, including whether
  digests can be computed in flight without a second pass.
- Whether long-running generation needs its own worker pool so it cannot starve short
  governance transitions — carried over from `ADR-0007`.
- Free-tier egress limits against realistic pack sizes and download frequency.
- Signed-URL TTL and single-use semantics on the provider.
