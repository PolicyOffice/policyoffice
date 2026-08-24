# Multi-Entity, Jurisdiction and Variant Model

How the system decides which text governs a given scope at a given instant, and why that
decision is never allowed to be approximate.

This is the chapter with the most European specificity in it. A group with entities in
Estonia, Poland and Finland does not have one policy estate with some regional folders. It
has a corporate baseline, local instruments that replace it where national law requires,
supplements that add obligations without displacing anything, and translations that must
change the language without changing the law.

## Three dimensions, never collapsed

```text
Organisation   Tenant → Legal Entity → Org Unit      which company, which population
Legal          Jurisdiction(s)                        which legal context
Presentation   Language / locale                      which words the reader sees
```

> **INV-ORG-004 — Jurisdiction is never derived from a legal entity's country of
> registration.**

A Lithuanian entity may employ someone operating under Finnish rules. A sectoral regime
may cut across every entity in the group. An entity registered in one country may operate
a branch in another. Deriving jurisdiction from the registration country is a shortcut
that produces confidently wrong answers, and confidently wrong is the worst category of
answer this product can give.

> **INV-APL-010 — A Space never determines applicability.**

Where a document is filed has no bearing on whom it governs. This is stated as an
invariant rather than as guidance because the failure is so easy: once a folder tree
exists, every product built on it eventually starts answering *who does this apply to*
with *whoever can see this folder*.

## Structure

| Entity | Shape | Rules |
|---|---|---|
| `LegalEntity` | Tree within one tenant | INV-ORG-001, INV-ORG-003 |
| `OrgUnit` | Tree within one tenant, each unit belonging to an entity | INV-ORG-001, INV-ORG-003 |
| `Jurisdiction` | Flat set with a level — supranational, national, regional, sectoral | INV-ORG-004 |
| `OrgMembership` | A user's dated assignment to an entity and an org unit | INV-ORG-002 |
| `GovernanceBody` | Constituted by one legal entity | INV-ORG-005 |

> **INV-ORG-001 — Legal entity and org unit hierarchies are acyclic and contained wholly
> within one tenant.**

> **INV-ORG-002 — Org memberships are dated. A membership that has ended is never deleted
> or rewritten, because point-in-time resolution depends on it.**

> **INV-ORG-003 — Closing a legal entity, org unit or governance body marks it inactive
> and never deletes it while any governed record references it.**

> **INV-ORG-005 — A Governance Body belongs to exactly one legal entity, and dissolving it
> never alters the decisions it made.**

An entity that has been wound up still appears in the history of everything it governed.
*"Which policy applied to the Warsaw branch in 2027"* must remain answerable in 2031,
after the branch has been closed and its people redistributed — and it is only answerable
if the branch, the memberships and the intervals all survive.

## Variants

A `DocumentVariant` is a scoped expression of one `Document`. Four relationship types,
with genuinely different semantics:

| Type | Meaning | Displaces the baseline |
|---|---|---|
| `BASELINE` | The default normative text where nothing more specific applies | — |
| `REPLACEMENT` | Substitutes the baseline within its scope | Yes, within its scope |
| `SUPPLEMENT` | Adds obligations alongside whatever resolved | No |
| `TRANSLATION` | A semantically equivalent presentation of another variant | No — it is not a normative object at all |

> **INV-APL-011 — Every Document has exactly one `BASELINE` variant, created with it and
> never deleted.**

> **INV-APL-005 — Supplements coexist with the resolved baseline or replacement; they
> never replace it.**

> **INV-APL-006 — Language selection happens only after normative scope resolution; a
> translation never alters legal scope.**

The last rule is the one that most often gets implemented backwards. Choosing Finnish must
not change which rules apply — it changes only which words express them. A translation
that carries its own applicability is not a translation; it is a replacement wearing a
flag icon, and it should be modelled as one.

Modelling variants as children of a shared `Document` rather than as free-standing
documents linked by a parent identifier was contradiction 1 in `consolidation-notes.md`.
The shared identity is what makes any of the resolution below possible: without it, "the
Polish HR policy" and "the group HR policy" are unrelated objects, and no query can tell
that one displaces the other.

## Applicability rules and inheritance

An applicability rule attaches to a variant and states which scopes it includes or
excludes, over a dated interval.

| Inheritance mode | Meaning |
|---|---|
| `MANDATORY` | Descendant entities inherit it and **may not** replace it. Only supplements are permitted below |
| `DEFAULT` | Descendant entities inherit it unless an approved replacement covers them |
| `LOCAL_ONLY` | Applies to the named scope only and does not propagate downward |

> **INV-APL-012 — Where a rule is `MANDATORY` for descendants, no `REPLACEMENT` variant
> may be published for a descendant scope. Only `SUPPLEMENT`.**

This is how a group states *"this one is not negotiable locally"* and has the system
enforce it, rather than trusting that no subsidiary will publish its own version. Local
divergence from a mandatory instrument is a waiver — approved, time-bound, with
compensating controls — not a quiet local replacement.

## Resolution

> **INV-APL-001 — Applicability resolution is deterministic: identical inputs always
> produce an identical result set.**

### The resolver takes a scope, not a person

This distinction matters and neither source blueprint stated it cleanly.

Resolution answers: *for scope `(legal_entity, org_unit, jurisdiction)` at instant `T`,
which version of document `D` governs?* A person is mapped to one or more scopes through
their memberships at `T`. Somebody dual-hatted across two entities has two contexts, and
their obligations are the union across them, each labelled with the context that produced
it.

Two contexts yielding different versions of the same document is therefore **not** a
conflict. It is a true statement about a person who works for two companies. A conflict is
strictly a failure to resolve *within a single scope*, and only that case blocks anything.

### Algorithm

For scope `S` and instant `T`:

```text
1. Resolve the entity, org unit and jurisdictions of S as they were at T.
2. Take every variant of D having a version effective at T whose applicability
   rules include S and do not exclude it.
3. Partition into  { BASELINE, REPLACEMENT } · { SUPPLEMENT } · { TRANSLATION }.
4. From the normative partition, select exactly one by specificity:
     a. exact legal entity  +  exact jurisdiction
     b. exact legal entity
     c. nearest ancestor entity  +  exact jurisdiction
     d. nearest ancestor entity
     e. tenant baseline
5. Two candidates at the same rung  →  INVALID. Fail closed.
6. Include every matching supplement. No selection is performed among them.
7. Select the presentation language from translations linked to the version
   chosen in step 4.
8. Return: one normative version · zero or more supplements · one locale.
```

> **INV-APL-002 — Exactly one baseline-or-replacement branch resolves for a given scope
> and instant.**

Step 4 walks *up* the entity tree, so a subsidiary with no local instrument inherits its
parent's, and a group with nothing more specific falls through to the tenant baseline.
Step 5 is where the model refuses to guess.

### Conflicts fail closed, twice

> **INV-APL-003 — Two replacements of equal specificity claiming the same scope and
> interval block publication.**

> **INV-APL-004 — If an impossible conflict reaches the reader path, resolution fails with
> a governance error and never selects arbitrarily.**

Two defences, deliberately. The first is the one that should always fire: publication
validates the candidate against every scope it would claim, and a collision with an
existing effective variant blocks the release with an explanation of which scopes collide
and which variants are competing.

The second exists because the first can be defeated by a race, a restore from backup, or a
data migration. When resolution nevertheless finds two candidates at the same rung, the
reader gets a governance error and an alert is raised. Being loudly unable to answer is
recoverable. Silently picking one is not: nobody discovers it until a regulator asks why
half the Polish workforce was governed by the wrong instrument.

## Alignment, not automatic propagation

> **INV-APL-007 — Publishing a master version never auto-merges, auto-translates or
> overwrites derived variants. It marks them alignment-required.**

> **INV-APL-008 — Alignment-required status cannot be cleared without a recorded
> governance action.**

When the group baseline moves from v3 to v4, every replacement, supplement and translation
derived from v3 gets an `AlignmentObligation`: an open record naming the upstream version
that raised it and why. Local owners are notified. The derived variant remains effective —
it is not withdrawn, and readers in its scope are not left ungoverned — but it is visibly
stale.

Closing the obligation requires a recorded action: adopting the change in a new local
version, completing a review that concludes no local change is needed, or recording a
justified divergence. Dismissing it is not one of the options, which is the entire point:
a flag anyone can clear is a flag everyone clears.

Machine translation and automatic merge are excluded by INV-APL-007 for the same reason
runtime AI is excluded from every domain operation (AGENTS.md rule 6): controlled content
is never rewritten by a machine. A future AI assistant may *draft* a proposed alignment
for a human to approve through the normal workflow. It may not produce a governed version.

## History

> **INV-APL-009 — Historical resolution uses memberships, entity structure and rules as
> they were at the requested instant, not as they are today.**

An as-of query is not a filter over today's state. Resolving "what governed the Warsaw
branch on 14 February 2027" uses the memberships valid on that date, the entity tree as it
stood, the applicability rules in force, and the version whose effective interval
contained the instant. Every one of those inputs is dated for exactly this reason, and
this is what INV-EVD-007 relies on when an evidence pack reconstructs a point in time.

## Worked examples

| Configuration | Result |
|---|---|
| Group Information Security baseline, plus an Estonia supplement | Estonian scopes receive both, with the baseline as the normative branch |
| Group HR baseline, plus a Poland replacement | In-scope Polish users receive the replacement instead of the baseline; everyone else the baseline |
| Code of Conduct in English, with a linked Finnish translation | Finnish-locale readers see the Finnish text of the same normative version. Scope is unchanged |
| Two Polish HR replacements with identical scope and interval | The second publication is blocked, naming the collision |
| Group baseline reaches v4 while the Estonian adaptation derives from v3 | The Estonian variant stays effective and is marked alignment-required. Nothing is overwritten |
| A user belongs to org units in two entities | Obligations resolve per context and are labelled by context. Not a conflict |
| A mandatory group policy, and a subsidiary that wants a local variation | A replacement is refused (INV-APL-012). The route is a supplement, or an approved waiver |
| An entity is closed | It becomes inactive. Historical resolution for past instants still resolves through it |

## Pilot scope

| Capability | Pilot | Commercial V1 |
|---|---|---|
| `LegalEntity` exists in the schema | Yes, one default entity per tenant | Full hierarchy |
| Dated `OrgMembership` | Present, not exercised for resolution | Authoritative for resolution |
| `Jurisdiction` | Present, not exercised | Authoritative |
| `BASELINE` variant | Yes | Yes |
| `REPLACEMENT`, `SUPPLEMENT`, `TRANSLATION` | No | Yes |
| Specificity ladder | Not exercised — one entity, one baseline | Yes |
| Alignment obligations | No | Yes |

The concepts exist in the MVP schema and the behaviour arrives in V1. That split is
deliberate: deferring the *concepts* would force a painful migration through every
governance table, while building the *resolution engine* now would delay the golden slice
for capability the Pilot cannot demonstrate.

The table above is now the decision, not a proposal: open decision 1 was settled on
2026-08-24 in favour of schema-complete and behaviour-minimal. One question remains open —
whether Pilot applicability is expressed as explicit audience lists or as rules — and it
changes no invariant above.
