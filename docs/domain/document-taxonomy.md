# Document Taxonomy and Governance Authority

Neither source blueprint modelled this properly. Both assumed a flat `PolicyType` that
carried a default workflow. Real organisations run something stricter: a ranked hierarchy
of document types whose approval requirements are prescribed by a single governing
document, and approval authorities that are frequently **collective bodies** rather than
individuals.

This chapter is derived from founder domain input describing a European payment
institution's internal governance framework, generalised so that every element is
tenant-configurable.

## The shape of the problem

A representative regulated organisation:

```text
Supervisory Board
    └── Management Board
            ├── AML Committee
            ├── Risk Committee
            └── departments — Compliance, Legal, Engineering, Finance …
```

with a ranked document taxonomy:

```text
Policy      ← highest; sets obligations and principles
Procedure   ← how a policy is executed, more granular
Manual      ← operational instruction, narrowest
```

and an approval chain that differs by type. For a Policy, typically:

```text
Author      the originating department
Reviewer    Legal
Reviewer    Head of Compliance
Approver    Management Board — as a body, not any single member
```

whereas a Manual may require only the head of the owning department.

Crucially, **none of this is universal**. A different organisation will have different
bodies, different type names, a different number of ranks and different authorities. All
of it is configuration, not code.

## `DocumentType`

Tenant-configurable. Every Document has exactly one.

| Attribute | Purpose |
|---|---|
| `code`, `name` | The tenant's own vocabulary — `POLICY`, `PROCEDURE`, `MANUAL`, `STANDARD`, `CHARTER` |
| `rank` | Integer precedence within the tenant. Lower rank = higher authority. |
| `mandated_authority` | The **minimum** approval authority this type requires |
| `default_workflow_template_id` | Starting workflow for new documents of this type |
| `default_review_rule` | Default cadence, e.g. every 12 months |
| `requires_attestation_by_default` | Whether material versions of this type normally trigger a campaign |
| `mandated_by_document_id` | Which governed document prescribes these rules — the Governing Framework |
| `status` | Active or retired. A retired type cannot be assigned to new documents; existing ones keep it. |

### Rank and contradiction

Rank exists so the system can express that a Manual may not contradict a Policy. In the
Pilot, rank is **descriptive**: it orders the register, drives display, and is recorded
in evidence. It does not yet block anything, because detecting contradiction requires
semantic comparison.

What rank *does* enable deterministically, and cheaply, later:

- a Procedure that claims to implement a retired Policy is a governance exception;
- a Manual whose owning department has no authority over the Policy it derives from is a
  governance exception;
- a lower-ranked document effective while its parent is withdrawn is a **policy gap**.

Those are structural checks, not language understanding. They are recorded as candidates
for Commercial V1, not built now.

### Mandated authority versus workflow

> **INV-APR-020 — A workflow may add approval requirements beyond its Document Type's
> mandated authority. It may never require fewer.**

This is the rule that makes the taxonomy load-bearing rather than cosmetic. If the
Governing Framework says a Policy requires Management Board approval, then no
administrator can configure a Policy workflow that omits the Management Board — not by
editing a template, not by choosing a different template, not by delegation.

Weakening a mandated authority requires changing the `DocumentType` configuration itself,
which is a separately audited administrative action that records which Governing
Framework version justified it.

**Mandated authority may be stated per materiality class.** Real governing frameworks
routinely say that a Policy needs board approval for a substantive change but permits a
named function to authorise a typographical correction, provided the correction is logged
and reported at the next review. A single scalar authority per type cannot express that,
and forcing a board resolution to fix a misspelling is how a governance product teaches
its users to work around it.

So `mandated_authority` is a structure keyed by materiality, not a single value, and the
floor rules are unchanged: INV-APR-020 holds for whichever entry applies, an omitted class
inherits the strictest one stated, and no class may be configured to require nobody. The
storage was already `jsonb`, so this costs a specification sentence now and a migration
never.

## Information classification

A second axis, and the distinction is worth being pedantic about because collapsing it is
easy and expensive.

| Axis | Answers | Carried by |
|---|---|---|
| `DocumentType` | Under what authority is this approved, how often reviewed, does it require attestation | `Document`, snapshotted on each version |
| `InformationClassification` | How sensitive is this, who may it be shown to, how must it be handled | Snapshotted on each version |

A Policy may be public; a Manual may be need-to-know. Neither fact tells you anything
about the other, and a scheme that ranks them together produces the confident nonsense of
a highly-classified low-authority document.

### Classification is a label, never a permission

> **INV-AUTH-019 — An information classification labels a version; it never grants, denies
> or scopes any capability, and the evaluator never reads it.**

This is the same refusal INV-AUTH-015 makes for Spaces, for the same reason. The moment
`RESTRICTED` starts *causing* denial, the tenant has two access models: the grants an
administrator can see and explain, and a label nobody thinks of as permission. Access
questions get answered by the label, grants stop being the whole story, and no one can say
why a given person can see a given document.

What classification legitimately does:

| Does | Does not |
|---|---|
| Appear on the reader view, on every rendered page, and in evidence pack manifests | Filter search results |
| State handling obligations to the person reading it | Enforce them |
| Record whether this level is externally disclosable, so a disclosure is a decision someone made | Authorise or refuse a disclosure |
| Inform the administrator deciding what grants to make | Substitute for making them |

An organisation that wants `RESTRICTED` documents reachable by fewer people expresses that
as grants, which are visible, dated, attributable and revocable. The label says what the
document is. The grant says who may read it. Keeping those apart is what makes either one
answerable.

### Reclassification

Classification is recorded on the version and never changes there (INV-DOC-010).
Reclassifying is a new version, exactly as retitling is — because *what was this document
classified as when the board approved it* is a question an auditor asks, and a mutable
field cannot answer it.

## `GovernanceBody`

Both blueprints modelled approvers as users, roles or groups with `ALL` / `ANY_ONE` /
`AT_LEAST_N` completion rules. That does not express *"the Management Board approved
this."*

A quorum of named individuals and a body resolution are different governance facts. A
board meets, minutes are taken, a resolution is recorded, and the institution — not five
people — has decided. Evidence for a regulator must say so.

| Attribute | Purpose |
|---|---|
| `code`, `name` | `MANAGEMENT_BOARD`, `SUPERVISORY_BOARD`, `AML_COMMITTEE` |
| `legal_entity_id` | Bodies belong to a legal entity; a group may have several boards |
| `parent_body_id` | Optional hierarchy — Supervisory above Management |
| `quorum_rule` | Informational for the Pilot; the recorded resolution is authoritative |
| `status` | Active or dissolved. Dissolution never rewrites historical decisions. |

`BodyMembership` records dated seats, optionally with `CHAIR` or `SECRETARY` roles.
Memberships are dated because evidence must be able to state who sat on the board at the
time a resolution was passed.

### `BODY_RESOLUTION` completion rule

A fourth completion rule alongside `ALL`, `ANY_ONE` and `AT_LEAST_N`. When a stage is
assigned to a Governance Body, exactly **one** `ApprovalDecision` satisfies the stage:

| Field | Always | Notes |
|---|---|---|
| `decided_by_type = BODY`, `decided_by_id` | yes | The body is the approver |
| `recorded_by_user_id` | yes | The authorised person who entered it, who must hold the capability to act for that body |
| `recorded_at` | yes | System timestamp, distinct from the resolution date |
| `resolution_reference` | **configurable** | Minutes or protocol identifier |
| `resolution_date` | **configurable** | The date the body actually resolved |
| `minutes_attachment` | **configurable** | The governed minutes document or file |
| `attending_members` | **configurable** | Who sat on the body for that resolution |

Only the first three are structural. Everything else is the customer's governance rule,
not ours — a small organisation may want nothing more than "the board approved this",
while a regulated one wants the protocol number, the resolution date and the minutes
attached. See `configuration-model.md`.

> **INV-APR-021 — A body resolution decision always distinguishes the deciding body from
> the user who recorded it. The recorder is never presented as the approver.**

> **INV-APR-024 — Which evidence fields a decision requires is tenant configuration, and
> the configuration version in force at decision time is recorded with the decision.**

That second rule is what keeps historical evidence interpretable. Without it, a decision
recorded in 2026 cannot later be judged against the rules that applied in 2026.

> **INV-APR-022 — Where a resolution date is recorded, it may precede `recorded_at` but
> may not precede submission of the content revision being approved.** A board cannot have
> resolved on text that did not yet exist.

That last rule is the interesting one. It is exactly the kind of backdating that regulated
organisations do accidentally, and catching it deterministically is the sort of thing the
product exists to do.

## `GoverningFramework`

The organisation's internal constitution — its Internal Regulations, Statutes, Rules of
Procedure. In Estonian practice, the *põhikiri*.

It is modelled as an ordinary `Document`, with `is_governing_framework = true`. This is
deliberate: it is itself a governed document with versions, approvals, reviews and
evidence. It is not special-cased configuration living outside the system it governs.

Its role in the model is a **provenance link**: each `DocumentType` records which
Governing Framework version prescribes its rules. This costs nothing and buys two things:

1. When an administrator asks *why does a Policy need board approval?*, the system answers
   with a citation rather than a shrug.
2. When the Governing Framework is superseded, every `DocumentType` that cites the old
   version is flagged `alignment_review_required` — reusing the same mechanism as stale
   translations and stale local variants.

> **INV-DOC-030 — Publishing a new version of a Governing Framework marks every
> `DocumentType` deriving authority from the prior version as requiring alignment review.
> It never silently rewrites any type's mandated authority.**

## Explicitly out of scope

**Conformance checking of the whole estate against the Governing Framework.** The
scenario: an organisation discovers that approving a given procedure actually requires
person X, not person Z, because their constitution says so — and their configuration was
wrong for two years.

Recorded here so the model does not foreclose it, and deliberately not built.

Worth noting for whoever picks it up: the valuable half of this is **deterministic, not
AI**. If the Governing Framework's rules are captured as `DocumentType.mandated_authority`
configuration, then checking whether every workflow and every historical approval actually
satisfied the mandate is a rules query over structured data. The parts that genuinely need
language understanding are narrower: reading a prose constitution and *proposing* the
configuration, and detecting contradiction in content between ranked documents.

The deterministic half should be built first, and it belongs to Commercial V1 or later.
The AI half stays advisory and human-confirmed under the standing AI posture.

## Type versus title

Titles are free text and routinely lie about type. A document called *"SCA Guidelines
v2"* may be, in the organisation's own taxonomy, a Manual — because "Guideline" is not a
type that exists there, and because the version belongs in metadata rather than the title.

The rules:

1. `document_type_id` is authoritative. The title is a label and never derives type.
2. The title is not parsed for versions. `v2` in a title is a data-quality observation,
   never an input to version resolution.
3. Title drift is a **governance hygiene exception**, surfaced in the register, never an
   error that blocks work: *"title suggests a type not in your taxonomy"* and *"title
   appears to contain a version number"*.

Both checks are simple string rules over the tenant's own configured type vocabulary. They
are Commercial V1 register-hygiene features, not Pilot scope, and they must never block
creating or publishing a document. Organisations arrive with messy estates; the product's
job is to make the mess visible, not to refuse the import.
