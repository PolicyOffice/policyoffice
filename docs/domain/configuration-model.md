# Configuration Model

The single most important boundary in this product:

> **Product invariants are never configurable. Customer governance rules always are.**

Get this line wrong in either direction and the product fails. Make invariants
configurable and the guarantees become worthless — a customer who can switch off "no
timeout auto-approves" no longer has a system of record. Make governance rules fixed and
the product only fits organisations that happen to govern exactly like the first design
partner, which is none of them.

## Which side of the line

| Never configurable — product invariant | Always configurable — customer rule |
|---|---|
| Tenant isolation | Which document types exist, and what they are called |
| Released content cannot mutate | Type ranking and precedence |
| Approval binds an exact content revision | Who approves what, and in which order |
| No timeout ever auto-approves | Whether approval is required at all for a given type |
| Overdue review never invalidates an effective document | Review cadence, reminder offsets, escalation |
| Ambiguous applicability fails closed | Whether attestation is required, and for which materiality classes |
| Attestation binds an exact version | Which evidence fields a body resolution must carry |
| Assignment never grants access | Retention durations per record class |
| Audit is append-only | Which audit events are surfaced in which views |
| Evidence is generated from source records | What an evidence pack includes by default |
| A body is distinguished from the person recording its decision | Whether minutes, protocol numbers or attendance are recorded at all |

The full invariant list is `invariants.md`. Nothing in it has a configuration switch.

> **INV-CFG-001 — No tenant configuration can disable, weaken or bypass any invariant in
> the registry.**

## Configuration is versioned, and decisions remember which version applied

A governed action recorded in 2026 must remain interpretable in 2029, after the customer
has reorganised twice and rewritten their internal regulations. That is impossible if the
system only stores current configuration.

> **INV-CFG-003 — The configuration version in force at the time of a governed action is
> recorded with that action.**

So evidence can state: *"Under the configuration in force on 14 February 2027, a Policy
required Management Board approval and a minutes reference. Both were provided."* Not
merely: *"today, a Policy requires those things."*

This reuses the mechanism already applied to workflow template versions. It is the same
principle everywhere in this product: **history is interpreted under the rules that
existed then, never under today's.**

> **INV-CFG-006 — Configuration changes never retroactively alter completed governance
> records.**

## Governance profiles

Most customers should not start from an empty configuration screen. The product ships
**governance profiles**: complete, coherent starting configurations that an onboarding
conversation selects and then adjusts.

This is the work a **solutions engineer** does pre-sale and an **implementation
consultant** or **onboarding specialist** does post-sale. Shipping profiles is how a
single founder does that job at scale without a services team.

| Profile | For | Ships with |
|---|---|---|
| **Essential** | Small organisations that mainly need to stop losing track of documents | One document type. Single named approver. Owners, effective dates, annual review with reminders. Version history and audit. No governance bodies, no attestation campaigns, no evidence packs beyond a version history export. |
| **Standard** | Organisations with a compliance function and formal document classes | Ranked taxonomy — Policy, Procedure, Manual. Serial approval with reviewers separate from approvers. Attestation campaigns on material change. Evidence packs. Configurable review cadence per type. |
| **Regulated** | Financial institutions and comparable regulated entities | Everything in Standard, plus governance bodies with `BODY_RESOLUTION` approval, resolution references and minutes, a Governing Framework document with mandated authority per type, multi-entity and jurisdiction scope, retention rules and legal hold, full evidence packs. |

A customer on Essential who later needs board resolutions does not migrate to a different
product; they enable the capability. Profiles are a starting point, not a plan tier.

### Profiles are copied, never linked

> **INV-CFG-002 — Applying a governance profile copies configuration. It never creates a
> live link, and updating a profile never alters an existing tenant.**

This is the same rule as master documents and their local variants, for the same reason: a
vendor must never silently re-govern a customer. When we improve the Regulated profile,
existing Regulated tenants are unaffected. If a change is worth adopting, it is offered as
a reviewable suggestion, and adopting it is an audited configuration change.

## Relationship to commercial packaging

Profiles are **not** pricing tiers, and the two must not be conflated in the model. A
profile describes how an organisation governs. A plan describes what they pay for. A small
customer on Essential might still need EU residency; a large customer on Regulated might
not need SCIM.

Packaging can *reference* profiles when it comes to that, but the domain must not encode
price. Nothing in `docs/domain/` mentions plans.

## Changing configuration is a governed act

> **INV-CFG-004 — Every configuration change emits an audit event with actor, before and
> after state.**

> **INV-CFG-005 — Weakening a configured control requires elevated capability and a
> recorded reason.**

Weakening means: removing a mandated approver, disabling a required evidence field,
shortening a retention period, reducing a review cadence, or disabling attestation for a
materiality class that previously required it.

The easiest way to defeat a control is not to breach it but to quietly reconfigure it away
and then comply with the weaker rule. A system of record that does not notice this is not
a system of record. Under `INV-CFG-003`, the old rule and the moment it changed both
remain in evidence.
