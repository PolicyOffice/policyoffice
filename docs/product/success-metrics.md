# Success Metrics

What the product is trying to move, how each number is derived, and — as deliberately —
what it refuses to measure.

Every metric here resolves to authoritative records. A number that cannot be traced back
to the events and entities that produced it is not a metric; it is a claim, and this
product exists to eliminate exactly that category of claim.

## Outcome metrics

The four things a compliance function should find dramatically easier than it does today.

| Metric | Pilot target | Derived from |
|---|---|---|
| **Time for a reader to find the correct effective document** | Median under 30 seconds in usability testing | Observed task time, not instrumentation |
| **Time from evidence request to a usable pack** | Median under 60 seconds for a document pack; p95 under 5 minutes for a large one | `evidence_pack.requested` → `evidence_pack.generated` |
| **Time to answer "what governed X on date Y"** | Minutes, unassisted, by a compliance manager | Observed task time |
| **Reduction in manual audit-evidence preparation** | Against the design partner's own baseline, self-reported | Partner interview at pilot exit |

The fourth is soft on purpose. It is also the one that determines whether anyone renews,
so it is measured by asking rather than by pretending a proxy exists.

## Governance health

What the customer's dashboard shows about their own estate. These are the customer's
numbers, not ours — but if the product is working, they improve.

| Metric | Target | Derived from |
|---|---|---|
| Documents with an active owner | 100% | `Document.owner_user_id` non-null (INV-DOC-006) |
| Documents reviewed on time | Rising; measured against the partner's baseline | Completed review cases against their `due_at` |
| Median approval cycle time | Against the partner's baseline; a 50% reduction is the target worth aiming at | `approval_run.started` → `approval_run.completed` |
| Attestations completed by the due date | 95% in the Pilot, then benchmarked per customer | Assignment outcomes (INV-ATT-003) |
| Released versions with complete governance metadata — owner, applicability, approval, effective date, digest | 100% | Direct query. Anything less is a data-integrity defect, not a metric |
| Open policy gaps | Zero, and any occurrence investigated | `governance.policy_gap` events (INV-EFF-005) |
| Unresolved applicability conflicts | Zero | `governance.conflict_detected` events (INV-APL-003) |
| Alignment obligations older than one review cycle | Trending down | Open `AlignmentObligation` records (INV-APL-008) |

## Correctness and safety

These are not growth metrics. They are the ones that would end the product if they went
the wrong way, so they are tracked as defects rather than as trends.

| Metric | Target | Why |
|---|---|---|
| Cross-tenant isolation test failures | Zero, always | The single most severe possible defect (INV-TEN-001) |
| Access or effectivity incidents | Zero, each one investigated as a governance incident | Wrong version effective, or content visible to someone unauthorised |
| Evidence-critical transitions producing the expected event | 100%, asserted in contract tests | Evidential completeness (INV-AUD-001) |
| Evidence-pack validation success rate | 100% | Every file validates against its digest (INV-EVD-003) |
| Digest mismatches detected | Zero, each one a governance incident | `governance.digest_mismatch` |
| Invariants with no referencing test | Zero, enforced by CI | An invariant with no test is a claim, not a guarantee |

## Operational health

| Signal | Why it is watched |
|---|---|
| Scheduled transition delay | A late `version.effective` means the wrong text governs, briefly |
| Background job age | Effectivity, reminders and disposal all run on jobs |
| Audit event lag | An outbox backlog means committed changes are not yet provable |
| Notification delivery success | A reminder nobody received is a deadline nobody knew about |
| Search index lag | It must never cause a leak (INV-AUTH-011), but it can cause confusion |
| Evidence generation failure rate | The differentiator failing quietly is the worst version of failing |
| Authorization decision latency | One evaluator on every path means it is on every path |

## Commercial signals

Tracked for the business, kept out of the product's own instrumentation.

| Signal | Note |
|---|---|
| Design partner to paid conversion | The only real validation of the wedge |
| Time from tenant setup to first governed effective document | Activation. Target: under one working day |
| Weekly active compliance administrators | A cohort trend, not a total. Two admins using it daily is the shape of success here, not thousands of logins |
| Evidence packs generated per audit cycle | Proof the differentiating feature is actually used |
| Security review duration | A proxy for how much procurement friction the buyer-readiness pack removes |

## What this product refuses to measure

The category makes several of these easy, and at least one competitor ships them.

| Not measured | Why not |
|---|---|
| **Time an employee spends reading a document** | It proves nothing about understanding and everything about surveillance. It is also trivially gamed by leaving a tab open |
| **Scroll depth, or whether they reached the end** | Same, with a worse privacy profile |
| **Reader engagement, sessions, or logins as a success metric** | Optimising for time-in-product is wrong here. A reader who finds their answer in twenty seconds and leaves is the *success* case |
| **Per-employee compliance scores** | Turns a governance system into a performance-management tool, which is neither its purpose nor its lawful basis |
| **Search queries as behavioural data** | What people search for reveals what they are worried about |

Where a tenant has a documented need for something in this list, the capability can be
enabled deliberately and the configuration is itself audited (INV-CFG-004). The default is
off, and the product does not present these as features.

This is not squeamishness. A compliance product that quietly becomes employee monitoring
has undermined the function it sells to, and the DPO in the buying committee will find it.

## How targets are set

Pilot targets above are **hypotheses to validate with a design partner**, not industry
benchmarks. Two rules for handling them:

1. **Baseline before optimising.** Approval cycle time and evidence-preparation effort are
   meaningless without the partner's starting point, which is measured during onboarding.
2. **A metric that cannot be traced to source records is deleted, not estimated.** If
   dashboards and the underlying records disagree, the records are right and the dashboard
   is a defect.
