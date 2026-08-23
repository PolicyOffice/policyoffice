# Source Research — Archived, Non-Normative

These are the original research artefacts the canonical specification was consolidated
from. They are kept for provenance and are **not normative**.

> **If these documents and `docs/domain/` disagree, `docs/domain/` wins.**
>
> Agents should not read these to answer a question. Read `docs/domain/` and
> `docs/product/`. These exist so a human can check what the specification was derived
> from, and so `consolidation-notes.md` cites something that can actually be inspected.

| File | Role | Superseded by |
|---|---|---|
| `2026-08-master-product-blueprint-v0.1.md` | Primary domain authority during consolidation | `docs/domain/` |
| `2026-08-product-and-domain-blueprint.md` | Secondary — Space, waivers, API shape, ADR backlog, CI and delivery design | `docs/domain/`, `docs/engineering/` |
| `2026-08-strategic-market-research.md` | Positioning, ICP, competitive framing, pricing. Never a domain authority. | `docs/product/` |

Where the two blueprints contradicted each other, and which won, is recorded in
[`docs/domain/consolidation-notes.md`](../domain/consolidation-notes.md). Four concepts in
the specification appear in **neither** document — the ranked document taxonomy,
governance bodies, the governing framework, and the configurable/invariant boundary. Those
came from founder domain input and are marked as such in the same file.

These documents contain inline citation artefacts from the tools that produced them
(`citeturn…`). They are preserved verbatim rather than cleaned, because an archived
source that has been edited is no longer a source.
