# ADR-0004: Content storage and canonicalisation

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

Open decision 2 settled content as **file-centric**: the customer uploads the controlled
file, and those bytes are the governed artefact. `versioning.md` specifies what must be
true of the digest; this ADR decides how the bytes are stored and how the digest is
produced.

Two invariants set the bar:

> **INV-VER-009 — The content digest covers canonicalised content and all governed
> attachments, under a recorded canonicalisation schema version.**

> **INV-VER-013 — Every attachment on a Content Revision is governed content and
> participates in the digest.**

And one specification rule constrains the whole design, from `versioning.md`:

> Extracted text is derived, and never enters the digest. If it did, a change to the
> extraction library would invalidate every historical digest in the system.

## Decision

### Content-addressed objects, tenant-partitioned

Objects are stored under a key derived from their own digest:

```text
t/<tenant_id>/blob/<sha-256 hex>
```

Content addressing gives immutability for free: an object's key *is* a statement about its
bytes, so overwriting one with different content is not a mistake the storage layer can
make quietly. Uploads are write-once; a corrected file is a new object and a new content
revision (INV-VER-010).

**Deduplication stops at the tenant boundary, deliberately.** A global content-addressed
store would deduplicate identical files across tenants, which is efficient and
unacceptable: it makes the existence of an object in one tenant observable from another by
probing a digest, and it creates a shared object whose deletion is governed by two
customers' retention rules. INV-TEN-001 and INV-TEN-003 are worth more than the storage
saving. Identical files in two tenants are stored twice.

Within a tenant, deduplication is a welcome side effect — re-uploading an unchanged annexe
across ten revisions stores it once.

### The digest

`SHA-256`, written everywhere with its algorithm prefix — `sha-256:<hex>` — as the
manifest examples in `evidence-model.md` already show. The prefix is what makes an
algorithm change expressible later rather than a silent reinterpretation of historical
values.

The digest of a **content revision** is taken over its canonical manifest, not over any
one file. `versioning.md` defines the manifest's contents; this ADR fixes its
serialisation.

### Canonical serialisation

JSON, serialised canonically: keys sorted by code point, UTF-8, Unicode NFC, no
insignificant whitespace, no floating-point in the manifest at all — sizes are integers,
everything else is a string. Attachments are ordered by filename, then by digest as a
tiebreak.

`canonicalisation_schema_version` starts at `1` and is recorded on every revision. A
future version 2 changes nothing about existing revisions: they keep verifying under the
rules they were produced under, which is the entire point of storing the version alongside
the digest.

The manifest is stored, not merely computed. Recomputing it years later would require the
canonicalisation code of that era to still exist and behave identically; storing it means
verification needs only a hash function.

### Uploads

```text
1. Client requests an upload slot for a pre-release revision
2. Server issues a short-lived, single-use presigned PUT to a quarantine prefix
3. Client uploads directly to object storage
4. Server downloads, and independently computes size, media type and digest
5. Server moves the object to its content-addressed key and records the attachment
```

Step 4 is not optional. **The server never trusts a client-supplied digest**, because the
digest is the thing the entire evidence chain rests on, and a client-asserted hash is an
assertion rather than a measurement. The upload goes direct to storage so the application
never streams large files, but verification happens server-side regardless.

Media type is determined by inspection, not by the file extension or the client's
`Content-Type`.

### Derived artefacts

Three kinds, and none of them is ever normative:

| Artefact | Purpose | Hashed? |
|---|---|---|
| **Extracted text** | Comparison between revisions, and the deterministic materiality warnings | **Never.** Stored with the extractor's version so a re-extraction is detectable, and regenerable at any time |
| **Rendering** | The PDF a reader sees, and the one in an evidence pack | Hashed *as its own artefact* when included in a pack, never as the governed content |
| **Thumbnail or preview** | Register display | No |

Every one of them can be deleted and regenerated without touching a governed record. That
is the test for whether something is derived: if losing it would damage evidence, it is
not derived and it belongs in the manifest.

### Malware scanning

Customers upload arbitrary files, and readers download them. The Pilot has no scanning,
and this is recorded as an accepted risk rather than an oversight:

- Uploads require an authenticated principal with `document.edit_draft` in scope, so this
  is not an open upload surface.
- Files are served with `Content-Disposition: attachment`, a restrictive
  `Content-Security- Policy`, and never from the application's own origin.
- Scanning before a design partner's estate is imported is a **Decision Request**, because
  every workable option costs money.

Recorded here so that the first customer conversation about it starts from a decision
rather than a discovery.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Files in Postgres as `bytea` or large objects** | Simple, and it puts multi-megabyte documents in the database's backups, WAL and replication path. Object storage is what R2 and its equivalents are for |
| **Global content-addressed store, deduplicated across tenants** | The efficient answer, and it makes cross-tenant existence observable by digest probing. INV-TEN-001 outranks the saving |
| **Path keyed by revision instead of by digest** | Loses free immutability, and makes "are these two revisions' bytes identical" a comparison rather than an observation |
| **Trusting a client-computed digest** | The evidence chain's root would become a client assertion |
| **Hashing extracted text into the manifest** | Would give better tamper detection over the *meaning* of a document, and would invalidate every historical digest whenever the extraction library changed. Explicitly forbidden by `versioning.md` |
| **Storing renderings as governed content** | A rendering is a conversion. Governing it would mean re-approving the document whenever the converter changed |
| **Canonical CBOR or protobuf for the manifest** | Genuinely more canonical than JSON. JSON is readable in an evidence pack by a human with a text editor, which is worth more here than byte-efficiency |

## Consequences

### What becomes easier

- Verification needs only a hash function: the manifest is stored, the digests are in it,
  and nothing has to be recomputed by application code.
- Immutability of released content (INV-VER-003) is partly structural — the storage layer
  has no overwrite path for a content-addressed key.
- Re-extraction, re-rendering and format migrations are free, because none of them touches
  a governed record.

### What becomes harder

- **Storage costs more** than a deduplicated global store. Acceptable, and the alternative
  is a tenancy hole.
- **The upload path has more steps** than a direct PUT, because of server-side
  verification.
- **Comparison quality depends on extraction**, which is the known cost recorded with
  decision 2: good for `.docx`, weak for a PDF with no source document.
- **Malware scanning is an open risk** carried deliberately into the Pilot.

### What we have committed to maintaining

- Server-side digest computation. No path where a client-supplied hash is recorded.
- The stored canonical manifest, and its schema version alongside every digest.
- The derived/governed boundary: nothing derived is ever presented as approved content.

### Cost of reversing this

Low for the storage layout — objects can be re-keyed by rewriting a reference column. High
for the canonicalisation rules, because every historical digest was produced under them,
which is exactly why the schema version exists.

## To verify at repository bootstrap

- Cloudflare R2's EU jurisdiction restriction, against the residency commitment in
  decision
  7. If it cannot be constrained to the EU, this is a Decision Request, not a
     substitution.
- Presigned single-use PUT semantics and expiry on the chosen provider.
- Free-tier egress and operation limits against expected pack generation and reader
  downloads.
- A canonical JSON implementation in TypeScript that is deterministic across Node versions
  — or the decision to write and test the fifty lines ourselves rather than depend on one.
