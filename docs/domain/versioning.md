# Versioning, Immutability and Materiality

What an approver approved, expressed precisely enough that it can be proved years later.

Three objects carry the weight, and keeping them distinct is what makes the rest of the
product possible:

| Object | What it is | Mutable |
|---|---|---|
| **`DocumentVersion`** | A released revision of one variant, with a place in the ordering and an effective interval | Governed fields become immutable at approval |
| **`ContentRevision`** | An editable pre-release snapshot. Many precede one release | Until submission freezes it |
| **Content digest** | A hash over the canonicalised content and its governed attachments | Never |

## Sequences, labels and identity

Ordering is an internal fact. Display is a customer preference. They are never the same
field.

> **INV-VER-006 — Human-facing version labels ("3.1") are never used as identity or for
> ordering; a monotonic internal sequence is.**

Customers arrive with incompatible conventions — `1.0`, `v3`, `2027.02`, `Rev C` — and
several change convention halfway through their history. Any logic that sorts, compares or
resolves on the display label inherits every one of those inconsistencies. The display
label is a string the customer owns; `version_sequence` is an integer the system owns.

> **INV-VER-011 — `version_sequence` is monotonic per variant and never reused. Gaps left
> by cancelled or rejected candidates are never renumbered.**

Renumbering to close a gap would silently change what "version 4" refers to in every
approval record, attestation response and evidence pack that already names it. A gap is a
true statement about history: a candidate existed and did not survive.

## Drafting

> **INV-VER-001 — Multiple draft saves produce Content Revisions, never released
> Versions.**

Ten saves during an afternoon's editing produce ten content revisions and no released
versions. A product that increments a policy version on autosave manufactures governance
history that never happened, and it is a surprisingly common failure.

> **INV-VER-012 — At most one pre-release version exists per variant at any instant.**

`Draft`, `InReview`, `ChangesRequested` and `Approved` are all pre-release. Allowing two
open candidates for the same variant creates a question the model cannot answer — which
one supersedes which, and what happens to the loser's approvals — so the second creation
is refused rather than resolved. Terminal candidates do not count: after a rejection or a
cancellation, a new version may be created immediately.

If this restriction ever needs lifting, the ordering problem has to be solved first, and
the invariant is superseded explicitly rather than quietly relaxed.

## Submission freezes exactly one revision

> **INV-VER-002 — Submission freezes exactly one Content Revision, its digest and its
> governed attachments.**

> **INV-VER-010 — A Content Revision is immutable once submitted. Further editing creates
> a new revision.**

At `Draft → InReview` the system records the submitted revision, its canonical manifest,
its digest and the attachments incorporated into it. Approval decisions bind to that exact
revision (INV-APR-001). Approvers must not review a moving target, and the record of what
they reviewed must survive the next edit.

When changes are requested, the frozen revision stays frozen and the author's next edit
creates revision *n+1*. The trail therefore shows what was submitted, what was said about
it, and what was submitted next — which is precisely the sequence an auditor asks for.

## What immutability means after approval

> **INV-VER-003 — Normative content of an approved, published, effective, superseded or
> withdrawn Version can never be mutated by any code path.**

This is the core promise. Everything else in this document is detail underneath it.

Immutability is not, however, "nothing can ever change on the row". A tag edit should not
manufacture a policy version. The line runs between fields an approver relied upon and
fields that do not alter anyone's obligations.

> **INV-VER-007 — Fields an approver relied upon are immutable after approval.**

> **INV-VER-008 — Administrative fields that do not alter obligations may change
> post-approval, and every such change emits an audit event.**

| Field | After approval | Why |
|---|---|---|
| Normative body | **Immutable** | It is what was approved |
| Incorporated attachments | **Immutable** | Part of the approved content, and part of the digest |
| Applicability scope | **Immutable** | Changing who is governed changes the decision that was made |
| Variant relationship and source linkage | **Immutable** | Determines what this version replaces or supplements |
| Materiality classification | **Immutable** | Drives approval depth and re-attestation |
| Effective date | **Immutable** | Changing when it binds changes who was governed when |
| `document_type_id` as recorded on the version | **Immutable** | Determines which mandated authority applied |
| Change summary | **Immutable** | Approvers read it |
| Search tags, register categorisation | Mutable, audited | Alters no obligation |
| Internal administrative notes | Mutable, audited | Not part of the approved instrument |
| Operational ownership assignment | Mutable, audited — configurable to require review | Who maintains it is not what it says |
| Display label | Mutable, audited | Presentation only; identity is `version_sequence` |

Changing an immutable field is not a permission question with an administrator override.
There is no code path that performs it. Correcting one requires a new version, or — before
release — cancelling the candidate and starting a fresh one.

> **INV-VER-005 — An erroneous released Version is withdrawn or superseded with a reason;
> never edited, never deleted.**

The instinct to "just fix the typo in the effective version" is the instinct this product
exists to defeat. A corrected version is a new version, and the record shows both, which
is exactly what a regulator asking about the intervening six weeks needs to see.

## Canonicalisation and the content digest

> **INV-VER-009 — The content digest covers canonicalised content **and** all governed
> attachments, under a recorded canonicalisation schema version.**

> **INV-VER-013 — Every attachment on a Content Revision is governed content and
> participates in the digest. There is no unhashed attachment.**

A digest that omits attachments proves less than it appears to: the policy body is intact
while the incorporated procedure annexe it depends on could have been swapped. So there is
no notion of a "reference-only" file hanging off a revision. Material the organisation
does not intend to govern is not attached to a governed revision.

### The canonical manifest

The digest is not taken over "the file". It is taken over a **canonical manifest** — a
deterministic description of everything the approver relied on as content:

```json
{
  "canonicalisationSchemaVersion": 1,
  "contentRevisionId": "…",
  "contentParts": [
    { "partId": "body", "mediaType": "…", "digest": "sha-256:…" }
  ],
  "attachments": [
    { "filename": "…", "mediaType": "…", "byteSize": 0, "digest": "sha-256:…" }
  ]
}
```

`content_digest` is the digest of the canonical serialisation of that manifest.

This shape is deliberately independent of how content is authored and stored: the manifest
contract is the same under a native editor and under a file-centric model, and only the
production of `contentParts` differs.

**The Pilot is file-centric** (open decision 2, settled 2026-08-24). The customer uploads
the controlled file; those bytes are the governed artefact, and `contentParts` holds them.
A native editor later adds a part type rather than replacing the contract.

### What canonicalisation must guarantee

| Requirement | Why |
|---|---|
| Deterministic member ordering — attachments sorted by filename then digest | Two systems assembling the same revision must produce the same bytes |
| Fixed encoding: UTF-8, Unicode NFC, normalised line endings | Otherwise an editor's line-ending preference changes the digest |
| No generation timestamps, no host identifiers, no ordering by insertion | The manifest describes content, not the run that produced it |
| Byte-exact reproducibility from stored records alone | Verification must be possible outside the application, years later |
| The schema version is recorded on the revision and never reinterpreted | A future canonicalisation change must not silently invalidate historical digests |

The last row is the one people forget. When canonicalisation v2 arrives, every historical
revision keeps verifying under v1, because the version it was produced under is stored
alongside it. A digest whose algorithm has been changed underneath it proves nothing.

### What the digest does and does not prove

| Proves | Does not prove |
|---|---|
| The stored content and attachments are byte-identical to what was submitted and approved | That any particular rendering — PDF, print, screen — is faithful. Renderings are derived artefacts, and each is hashed separately in an evidence pack |
| Two records naming the same digest refer to the same content | Who created the content, or when. Attribution comes from audit events, not from the hash |
| Tampering after the fact is detectable by anyone holding the manifest | Tamper-*evidence* against an attacker who can rewrite both content and manifest. That requires signing or external anchoring, and is deliberately a later claim |

Governed metadata — applicability, effective date, materiality, variant relationship — is
protected by immutability (INV-VER-007) rather than by the digest. The approval decision
references the version as well as the revision, and those fields cannot change on it. If
cryptographic provenance is added later, extending the manifest to cover governed metadata
is the natural first step.

## Materiality

> **INV-VER-014 — Materiality is recorded by a human, confirmed at approval, and never
> derived from diff size or by an automated classifier.**

Whether a change is material is a legal and governance judgement. Replacing "may" with
"must" is three characters and a new obligation for every employee. Reformatting a
fourteen-page annexe is thousands of characters and changes nothing. Any system that
infers materiality from the size of the diff will get both cases wrong, and will get them
wrong in the direction of under-classification, because small edits look small.

| Class | Meaning | Default approval consequence | Default re-attestation consequence |
|---|---|---|---|
| `EDITORIAL` | Typography, formatting, broken links, spelling | Shortened approval where the tenant configures one | None |
| `NON_MATERIAL` | Clarification that changes no obligation | Standard or reduced workflow | None unless configured |
| `MATERIAL` | New or altered obligation, control, scope or responsibility | Full workflow | New campaign for the affected audience |
| `EMERGENCY` | Immediate risk, incident or legal response | The tenant's emergency workflow, which is shorter but never empty | New campaign, accelerated deadline |

Defaults are configuration, per `configuration-model.md`. The classes are not.

### Deterministic warnings

The system does not decide materiality, but it is not silent either. These checks are
string and structure rules over the diff and the governed metadata — no language
understanding, no model — and each raises a warning the author must address before
submission:

| Signal | Warning |
|---|---|
| Modal verbs added or removed — *must*, *shall*, *may*, *should* | Obligation strength may have changed |
| A numeric deadline, threshold or frequency changed | Reporting or control timing may have changed |
| A named accountable role changed | Accountability may have moved |
| Applicability scope changed — entity, org unit or jurisdiction | The governed population has changed |
| A section referenced by a waiver was modified | Existing deviations may need revalidation |
| Sanction, disciplinary or reporting-obligation wording changed | Consequences for individuals may have changed |
| Classified as `EDITORIAL` while any of the above fired | The classification and the change disagree |

A warning never blocks. It appears to the author at classification and to every approver
at decision time, so that an `EDITORIAL` label on a change that moved a deadline is a
visible choice someone made rather than an oversight nobody noticed.

### Who decides, and how it can change

Materiality is proposed by the author at submission and confirmed by approvers as part of
their decision — they are approving the classification along with the content.

> **INV-VER-015 — Materiality may be raised only by resubmitting under the workflow the
> higher class requires. Lowering it requires elevated capability and a recorded reason.**

The asymmetry is deliberate. Raising materiality can mean the approval requirements
already satisfied were the wrong ones, so the safe response is to run the correct workflow
rather than to accept a decision made under lighter rules. Lowering it is the cheapest
available way to avoid re-attesting an entire workforce, which is exactly why it needs a
capability, a reason and an audit event.

## Correcting things without mutating them

| Situation | Correct path | Never |
|---|---|---|
| Typo found in an effective version | New version, classified `EDITORIAL`, superseding the current one | Editing the effective version |
| Wrong effective date on an approved, unpublished version | Cancel the candidate; create and approve a new one | Adjusting the date |
| Wrong applicability discovered after publication | New version with corrected scope. The record shows who was governed in the interim | Rewriting scope in place |
| An approval recorded against the wrong body | Compensating decision event recording the correction and its reason | Editing the decision |
| A version published in error | Withdraw with reason. If nothing else is effective for the scope, the resulting `governance.policy_gap` is loud by design | Deleting the version |
| Content digest mismatch discovered | A governance incident, not a data-repair task. The version is quarantined from resolution and investigated | Recomputing the digest to match the current bytes |

The last row is worth dwelling on. Recomputing a digest so that verification passes is a
one-line fix that destroys the only evidence that something went wrong. It must not exist
as a capability, an administrative action or a maintenance script.

## What file-centric authoring means here

Open decision 2 was settled on 2026-08-24 in favour of file-centric content. Three
consequences follow, and the third is the one that is easy to get wrong.

**Editing means a new revision.** There is no in-place editing of a candidate's text. The
author uploads a replacement file, which creates content revision *n+1* (INV-VER-010).
This matches how the work is actually done — in Word, with tracked changes and Legal's
comments — and it means the drafting trail is a sequence of real artefacts rather than a
reconstructed diff of an editor's internal state.

**Renderings are derived and separately hashed.** The PDF a reader sees and the PDF in an
evidence pack are conversions of the governed file, not the governed file itself. Each is
hashed as its own artefact in a pack, and neither is ever presented as the approved
content.

**Extracted text is derived, and never enters the digest.** Comparison and the
deterministic materiality warnings both need the document's text, which is extracted from
the uploaded file. That extraction is a convenience over the governed bytes — it is not
normative, it is not part of `contentParts`, and it never participates in
`content_digest`. If it did, a change to the extraction library would invalidate every
historical digest in the system.

The known cost, recorded when the decision was made: warning quality depends on extraction
fidelity. It is good for `.docx` and weak for a PDF with no source document. An estate
that arrives as scanned PDFs will get comparison and warnings that are close to useless,
and the honest response is to say so during onboarding rather than to imply the checks are
running.
