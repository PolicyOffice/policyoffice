# Authorization Model

Who may see or do what. One evaluator, one algorithm, no second path.

Three questions run through this product and are permanently separate. Collapsing any two
of them is a disclosure bug waiting to be written:

| Question | Answered by | Chapter |
|---|---|---|
| May this principal see or act on this resource? | **Access** | this one |
| Does this document govern this person? | **Applicability** | `multi-entity-model.md` |
| Must this person explicitly acknowledge this version? | **Attestation** | `attestation-model.md` |

> **INV-AUTH-005 — Applicability never implies access. Being governed by a document grants
> no permission.**

> **INV-AUTH-006 — Attestation assignment never implicitly grants read access.**

The second rule is what stops a mis-targeted campaign from becoming an information-
disclosure mechanism. Instead, a campaign that targets someone who cannot read the version
fails its preflight and does not launch (INV-AUTH-007). The system never resolves that
situation by quietly granting access.

## The decision

```text
permitted =
      same_tenant
  AND principal_is_active
  AND exists an ALLOW grant for the capability, valid now, at a scope containing the resource
  AND NOT exists a DENY grant for the capability, valid now, at any scope containing the resource
```

> **INV-AUTH-001 — Default deny: absent an applicable grant, access is refused.**

Enforced at level 4 of the ladder in `invariants.md` — a single evaluator, with no code
path that answers an authorization question independently. That is the strongest level
available for a rule of this shape, and it only holds if there is genuinely one evaluator.
Every surface — UI, API, background job, export, webhook, search — asks the same function
the same way.

> **INV-AUTH-010 — API authorization is identical to UI authorization; neither path is
> more permissive.**

> **INV-TEN-004 — Tenant scoping is enforced below the presentation layer, so background
> jobs and APIs inherit it.**

## Capabilities

Capabilities are a closed enumeration. They are not strings assembled at call sites, and
they are not inferred from route names.

> **INV-AUTH-016 — Capabilities are a closed enumeration. A grant naming an unknown
> capability is invalid and is never evaluated as an allow.**

| Capability | Permits | Phase |
|---|---|---|
| `document.read` | Read effective and published versions in scope | MVP |
| `document.read_history` | Read superseded, withdrawn and pre-release versions | MVP |
| `document.create` | Create a Document and its baseline variant | MVP |
| `document.edit_draft` | Create and edit content revisions on a pre-release version | MVP |
| `document.submit` | Submit a revision for approval | MVP |
| `document.approve` | Record an approval decision on a resolved task | MVP |
| `document.publish` | Publish an approved version | MVP |
| `document.withdraw` | Withdraw a published or effective version | MVP |
| `document.cancel_version` | Cancel a pre-release version | MVP |
| `document.manage` | Change owner, type and register metadata | MVP |
| `document.retire` | Retire a Document once nothing of it is effective | MVP |
| `document.restore` | Restore a retired Document, which requires a new controlled version | MVP |
| `document.manage_applicability` | Change applicability on a pre-release version | MVP |
| `document.manage_access` | Grant and revoke access to a document | MVP |
| `variant.create` | Create replacement, supplement or translation variants | V1 |
| `review.perform` | Complete a review case with an outcome | MVP |
| `review.manage` | Configure review rules, cadence and escalation | MVP |
| `attestation.respond` | Acknowledge or decline an assignment held by oneself | MVP |
| `attestation.manage` | Create, launch, close and exempt within campaigns | MVP |
| `waiver.request` | Request a deviation | V1 |
| `waiver.approve` | Approve, reject or revoke a deviation | V1 |
| `evidence.generate` | Request an evidence pack | MVP |
| `evidence.download` | Download a generated pack | MVP |
| `audit.read` | Read the audit ledger | MVP |
| `body.act_for` | Record a decision on behalf of a specific Governance Body | MVP |
| `tenant.manage_identity` | Users, groups, memberships, provisioning | MVP |
| `tenant.manage_configuration` | Document types, workflows, statements, profiles | MVP |
| `tenant.manage_security` | Security settings, session policy, integrations | MVP |
| `tenant.manage_retention` | Retention rules and legal holds | V1 |
| `tenant.break_glass` | Start a time-bounded elevation session | V1 |

Two of these deserve note. `attestation.respond` authorises answering **one's own**
assignment and nothing else — it is not a capability over other people's obligations.
`body.act_for` is meaningless at any scope other than a specific `GovernanceBody`, and is
what INV-APR-023 requires before a body resolution can be recorded.

## Roles

A role is a named bundle of capabilities. It answers *what*, never *where*: a role that
has not been granted at a scope authorises nothing.

| Role | Capabilities |
|---|---|
| **Reader** | `document.read`, `attestation.respond` |
| **Author** | Reader, plus `document.create`, `document.edit_draft`, `document.submit`, `document.read_history` |
| **Reviewer** | Reader, plus `document.read_history` — and tasks assigned to them in a run. A reviewer never satisfies an approval requirement |
| **Approver** | Reviewer, plus `document.approve` |
| **Document Owner** | Author, plus `document.manage`, `document.manage_applicability`, `review.perform` |
| **Compliance Admin** | Owner, plus `document.publish`, `document.withdraw`, `document.cancel_version`, `document.retire`, `document.restore`, `document.manage_access`, `review.manage`, `attestation.manage`, `evidence.generate`, `evidence.download`, `audit.read` |
| **Entity Admin** | Compliance Admin, scoped to one legal entity's subtree |
| **Auditor** | `document.read`, `document.read_history`, `audit.read`, `evidence.generate`, `evidence.download` — and no capability that mutates anything |
| **Tenant Admin** | `tenant.manage_identity`, `tenant.manage_configuration`, `tenant.manage_security`, `document.manage_access` |

Two properties of this table are deliberate. **Tenant Admin is not a superuser**: it
administers the platform and cannot approve, publish or withdraw governed content. And
**Auditor holds no write capability at all**, so giving an external assurance provider
access can never put them in a position to alter the thing they are attesting to.

Customer job titles map onto these roles. They never become roles: "Head of Compliance
Nordics" is a Compliance Admin grant at a scope, not a new role definition.

> **INV-APR-011 — Where configured, separation of duties prevents the author being the
> sole final approver.**

Holding both Author and Approver is legitimate — in a fifteen-person company it is
unavoidable. What separation of duties constrains is the same natural person filling both
positions *in one run*, and it is configuration because the right answer differs by
document type and by organisation size.

## Scopes and containment

A grant is made at a scope. It reaches every resource that scope contains.

```text
TENANT
  └── LEGAL_ENTITY
        ├── ORG_UNIT                    (owning chain, not applicability)
        │     └── DOCUMENT
        │           └── DOCUMENT_VARIANT
        │                 └── DOCUMENT_VERSION
        └── GOVERNANCE_BODY             (carries body.act_for only)
```

> **INV-AUTH-017 — Grant inheritance follows administrative containment — a document's
> owning org unit, its legal entity, the tenant — and never applicability scope.**

This is the rule that keeps the two dimensions apart in the implementation and not merely
in the prose. A document owned by Group Compliance and applying to every employee in four
countries is contained by Group Compliance for authorization purposes. The four countries
appear in its applicability and give nobody a single additional permission.

> **INV-AUTH-015 — A Space never grants, denies or scopes any capability.**

`SPACE` is absent from the scope enumeration. A Space organises the register; it is not a
permission surface, and "everyone with access to the Security space" is not a sentence
this model can express. Documents are reached through the org-unit chain or through direct
grants, both of which are explicit.

> **INV-AUTH-008 — A narrow direct grant exposes only its target and never enables
> browsing its ancestors.**

An external lawyer granted `document.read` on one document sees that document. They do not
see the org unit that owns it, its sibling documents, its Space, the register, or any
count or facet that would reveal them. "One document, not the whole estate" is a core use
case, not a special case.

## Grants

| Field | Meaning |
|---|---|
| `effect` | `ALLOW` or `DENY` |
| `principal` | A user, a group or an API client. Never a role — a role is what is being granted |
| `role_id` or `capability` | A bundle, or one explicit capability |
| `scope_type`, `scope_id` | Where it applies |
| `valid_from`, `valid_until` | Half-open interval in UTC. Open-ended is permitted for standing organisational grants; every temporary grant carries an end |
| `granted_by`, `granted_at`, `reason` | Accountability. Required for every `DENY` and every time-bounded grant |

### Deny wins, always

> **INV-AUTH-002 — An explicit deny defeats any inherited or direct allow.**

Deny wins regardless of specificity. A `DENY` at tenant scope defeats an `ALLOW` at
document scope, and a `DENY` at document scope defeats an `ALLOW` at tenant scope. There
is no "more specific grant wins" rule, because specificity-ordering is how permission
systems become unpredictable: administrators stop being able to answer *why can this
person see this* without running the evaluator in their head.

Deny exists for two situations that genuinely need it — a document sensitive enough that
broad organisational grants must not reach it, and a conflict of interest that must be
enforced rather than trusted. It is not the ordinary way to shape access, and the product
should make that clear in the interface. Complex deny trees are administratively
unmaintainable, and an unmaintainable access model eventually gets replaced by a broad
grant.

### Evaluation

```text
1. Is the resource in the principal's tenant?          no  → NOT FOUND
2. Is the principal active?                            no  → DENY
3. Collect grants for the principal and their groups,
   valid at this instant, at any scope containing the resource
4. Any DENY matching the capability?                   yes → DENY
5. Any ALLOW matching the capability?                  yes → ALLOW
6. Otherwise                                                DENY
```

Step 1 returns *not found*, never *forbidden*.

> **INV-TEN-002 — A valid identifier from another tenant behaves as not found, never as
> forbidden.**

"Forbidden" confirms the resource exists. For a compliance product that is a real
disclosure: knowing that a competitor's tenant contains a document with a given
identifier, and often its type, is information they did not consent to share.

### Time is part of the check, not a cleanup job

> **INV-AUTH-003 — A grant with a validity interval stops authorising at expiry, evaluated
> during the authorization check itself.**

> **INV-AUTH-004 — An expired grant cannot be prolonged by a cached session or open
> page.**

A nightly job that revokes expired grants is not an access control; it is a reconciliation
task that happens to run after the fact. The evaluator compares against the current
instant on every check, and the job exists only to materialise the expiry and emit
`access.expired`. If the job never ran, the external auditor's access would still stop at
17:00 on the day it was granted until.

Session caching is bounded by the same rule. Whatever is cached to make the product fast
must not outlive the entitlement it was derived from.

## Worked examples

| Situation | Outcome |
|---|---|
| Compliance Manager holds Compliance Admin at tenant scope | Manages documents tenant-wide, subject to any explicit deny |
| HR reviewer holds Reviewer at `Estonia → HR` | Review actions inside that subtree only; nothing elsewhere is visible |
| External lawyer needs one document for seven days | `document.read` at `DOCUMENT` scope, `valid_until` set, reason recorded. No ancestor is browsable |
| Employee holds broad read but is conflict-restricted from the acquisition policy | `DENY` at that document defeats the inherited allow |
| Employee is targeted by a campaign but lacks read access | Preflight fails; the campaign does not launch. Nobody is granted access to fix it |
| A user's temporary grant expires while their page is open | The next check denies. No logout is required, and no job needs to have run |
| An administrator knows another tenant's document identifier | Not found. No metadata, no timing difference, no facet count |
| A document applies to someone with no read grant | They are governed and cannot read it. That is a governance defect to surface — an unreadable obligation — not an access decision to override |
| Someone holds `body.act_for` on the AML Committee | They may record that committee's resolutions, and no other body's |

The eighth row is worth stating plainly, because the alternative is tempting.
Applicability generating access would make the product feel more helpful and would mean
that a mistake in an applicability rule silently publishes a document to whoever the
mistake caught.

## Elevation and break-glass

> **INV-AUTH-013 — Privilege elevation and break-glass are time-bounded, justified and
> separately audited.**

| Property | Requirement |
|---|---|
| Reason | Free text, required, recorded on the session and on every action taken inside it |
| Expiry | Mandatory and short. There is no open-ended elevation |
| Approval | Configurable per tenant: none, or a second authorised person |
| Audit | `breakglass.started` and `breakglass.ended`, plus `elevation_session_id` on every event produced inside the session (INV-AUD-006) |
| Visibility | The tenant's administrators are notified when a session starts, not only when they go looking |
| Scope | Bounded like any other grant. Break-glass is not a tenant-wide skeleton key by default |

Standing broad access is what security reviewers ask about, and "our support engineers can
read any customer's data" is the answer that loses deals. The mechanism above is how the
answer becomes "only inside a justified, expiring, individually audited session that the
customer can see".

## Deactivation and offboarding

> **INV-AUTH-014 — Deactivating a user revokes active sessions and prevents new governed
> actions, while historical attribution is preserved.**

| Effect | Immediate |
|---|---|
| Sessions revoked | Yes |
| Grants stop authorising | Yes — the principal fails step 2 of the evaluation |
| Open approval tasks | Become unresolvable and require authorised reassignment. Nothing auto-approves and nobody is substituted (INV-APR-005) |
| Open attestation assignments | Cancelled as `CANCELLED_DEPARTURE`, retaining the record that the obligation existed (INV-ATT-005) |
| Documents they owned | Immediately visible as an ownership exception (INV-DOC-006) |
| Completed decisions and responses | Untouched. They remain attributed, because history is not editable |

## Machine principals and delegated authority

An API client, an integration and — later — an AI agent connected to a customer's
assistant are all the same thing to this model: a principal that is not a person.

> **INV-AUTH-018 — Where a machine principal acts on behalf of a human, effective
> authority is the intersection of the two principals' grants, never the union, and never
> either one alone.**

Three rules follow, and none of them is optional.

| Rule | Consequence |
|---|---|
| A machine principal holds `AccessGrant` rows like any other principal | There is no second table of machine capabilities, and no second evaluator to keep in step. `ApiClient` stores identity and credential state; it stores nothing about what its holder may do |
| A delegated call carries both identities | `actor_id` is the machine principal that made the call; `originating_actor_id` is the human on whose authority it acted (INV-AUD-006). An event naming only one of them cannot answer *who was actually responsible* |
| Intersection, evaluated per request | A broadly-granted integration reaching a narrowly-permitted user's session gets the narrow answer, and a narrow integration reaching a broadly-permitted user gets the narrow answer too |

The failure this prevents is specific and is the one that matters commercially. An
organisation connects an assistant to the product. The assistant is provisioned once, by
an administrator, with the access an administrator has. Every employee who then asks it a
question is answered with the administrator's reach. The product has become a
privilege-escalation path around every grant in the tenant, and it will not look like a
bug — it will look like the integration working.

Nothing here is new machinery. It is the existing evaluator, given a principal type it
already has to handle, and refused the shortcut of a private capability list.

## Every other surface

Authorization that only holds in the interface is not authorization.

| Surface | Rule | Invariant |
|---|---|---|
| Search | Enforced at retrieval, never by trusting index filtering alone. A stale index must not leak a withdrawn or newly restricted document | INV-AUTH-011 |
| Result metadata | Titles, snippets, breadcrumbs, counts and facets are all subject to the same check. Metadata disclosure is disclosure | INV-AUTH-012 |
| Errors and timing | Identical shape and comparable timing for *absent* and *not permitted*, so neither can be distinguished by probing | INV-TEN-005 |
| Background jobs | Run as an explicit principal with explicit capabilities. There is no "system user with everything" | INV-TEN-004 |
| Exports and evidence packs | Bounded by the requester's capabilities at request time | INV-EVD-010 |
| Webhooks and API clients | Same evaluator, same scopes, same audit | INV-AUTH-010 |
| Delegated machine calls | Intersection of machine and human authority, evaluated per request | INV-AUTH-018 |
| Legal hold | Grants visibility to nobody. Retention and access are independent axes | INV-AUTH-009 |
