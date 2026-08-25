# Physical Data Model

The schema, derived from `docs/domain/domain-model.md` and the decisions in `ADR-0000`
through `ADR-0010`.

This is where the enforcement ladder stops being a principle and becomes DDL. Every
invariant targeted at level 1 or level 2 in `invariants.md` maps to a mechanism below, and
where one could not be reached, the drop is recorded with a reason rather than left
unstated.

Read `domain-model.md` for what these entities *mean*. This document does not repeat it.

## How to read this

Tables whose constraints carry an invariant are given in full DDL. The rest are given as
column lists, because their shape is unremarkable and repeating forty `create table`
statements would bury the ones that matter.

Every statement here is illustrative of intent. The authoritative schema is the migration
chain (`ADR-0009`), and CI's drift check keeps the two honest.

## Conventions

### Naming

`snake_case`, singular table names. Three domain terms collide with SQL reserved words and
are renamed — the only places where the physical model departs from the ubiquitous
language, and each is noted where it appears.

| Domain term | Table | Why |
|---|---|---|
| `User` | `app_user` | `user` is reserved |
| `Group` | `user_group` | `group` is reserved |
| `Role` | `security_role` | `role` is reserved, and `role` alone would read ambiguously next to the database roles from `ADR-0009` |

### Types

| Purpose | Type | Note |
|---|---|---|
| Identity | `uuid`, `default gen_random_uuid()` | Opaque. Never derived from customer data (INV-VER-006) |
| Instants | `timestamptz` | UTC. There is no `timestamp` column anywhere (INV-TIME-001) |
| Intervals | `tstzrange` with `[)` bounds | Half-open, so no instant belongs to two consecutive intervals (INV-TIME-005) |
| Text | `text` | No `varchar(n)`; length rules are domain rules, expressed as `check` where they exist |
| Closed sets | Postgres `enum` types | Level 3 of the ladder — the type system refuses an invalid state |
| Structured attributes | `jsonb` | Only where the shape is genuinely open, and always with a size `check` |
| Digests | `text` with an algorithm prefix — `sha-256:…` | Makes an algorithm change expressible rather than a silent reinterpretation (`ADR-0004`) |

**Enums, not `text` with a `check`.** A lifecycle state is a closed set that gains values
rarely and loses them never — the same permanence the invariant registry gives IDs. An
enum makes an invalid value unrepresentable, and Drizzle derives a TypeScript union from
it, so one definition produces enforcement in both the database and the type system.
Adding a value is `alter type … add value`; removing one is not supported, which is the
correct difficulty for deleting a governance state.

### Every tenant-owned table

```sql
tenant_id   uuid not null references tenant(id),
id          uuid not null default gen_random_uuid(),
created_at  timestamptz not null default now(),
updated_at  timestamptz not null default now(),
row_version integer not null default 1,          -- INV-TIME-003, optimistic concurrency
primary key (tenant_id, id),
unique (id)                                       -- so an id alone is a valid external reference
```

and, from `ADR-0001`:

```sql
alter table <t> enable row level security;
alter table <t> force  row level security;
create policy tenant_isolation on <t>
  using (tenant_id = current_setting('app.tenant_id')::uuid);
```

The composite primary key is what makes a cross-tenant foreign key unrepresentable
(INV-TEN-003). **Every foreign key between tenant-owned tables is composite**, carrying
`tenant_id`. The separate `unique (id)` exists so identifiers can appear in URLs, events
and evidence packs without a tenant prefix, while the key the database enforces still
includes the tenant.

`row_version` is incremented on every update and checked on write. A stale write conflicts
rather than overwriting someone's governance decision (INV-TIME-003).

### Every governed action

```sql
configuration_version_id uuid not null,   -- INV-CFG-003
foreign key (tenant_id, configuration_version_id)
  references configuration_version (tenant_id, id)
```

Recorded on approvals, decisions, campaigns, responses, review cases and evidence packs,
so that a 2027 record stays interpretable in 2031 under the rules that applied to it.

---

## Enforcement map

The exit criterion for this phase: every invariant targeted at level 1 or 2 maps to a
mechanism, or the drop is recorded.

| Invariant | Level | Mechanism |
|---|---:|---|
| INV-TEN-001 no cross-tenant reads | 2 | `force row level security` + policy on every tenant-owned table |
| INV-TEN-002 not-found, not forbidden | 2 | RLS filters the row; the data layer returns nothing and cannot distinguish |
| INV-TEN-003 no cross-tenant reference | **1** | Composite primary keys and composite foreign keys throughout |
| INV-TEN-004 scoping below the UI | 2 | The policy applies to the connection, so jobs and API inherit it |
| INV-ORG-001 acyclic hierarchies | 2 | `check (id <> parent_id)` plus a recursive trigger on insert and update |
| INV-ORG-002 memberships never rewritten | 2 | `revoke delete`; corrections close an interval and open a new row |
| INV-ORG-003 no delete while referenced | **1** | `on delete restrict` on every reference, plus `status` for inactivation |
| INV-DOC-004 documents never hard-deleted | **1** | `on delete restrict` from every governed child |
| INV-DOC-005 type is authoritative | **1** | `document_type_id` is `not null`; no derivation path exists |
| INV-DOC-006 one owner, or a visible exception | 3 | `owner_user_id` nullable by design; the register query surfaces nulls |
| INV-DOC-008 no retirement while effective | 2 | Trigger on `document.lifecycle_status` |
| INV-DOC-009 type recorded on the version | **1** | `document_version.document_type_id` `not null`, immutable by trigger |
| INV-DOC-010 title and classification recorded on the version | **1** | `document_version.title` and `classification_id` `not null`, immutable by the same trigger |
| INV-VER-002 submission freezes one revision | 2 | Partial unique index on submitted revisions per version |
| INV-VER-003 released content immutable | 2 | Trigger refusing `update` of governed columns past `approved` |
| INV-VER-006 labels are not identity | **1** | `version_sequence integer`; `display_label` has no unique or ordering role |
| INV-VER-007 approver-relied-upon fields immutable | 2 | The same trigger, column by column |
| INV-VER-010 submitted revisions immutable | 2 | Trigger refusing `update` once `submitted_at` is set |
| INV-VER-011 sequence monotonic, never reused | 2 | `unique (tenant_id, document_variant_id, version_sequence)`; gaps permitted |
| INV-VER-012 one pre-release version per variant | 2 | Partial unique index on pre-release lifecycle states |
| INV-VER-013 every attachment is governed | **1** | `content_attachment` has no "reference only" column to set |
| INV-EFF-002 one effective version per scope | 2 | `exclude using gist` over `(tenant_id, document_variant_id, effective_range)`, verified including under a race |
| INV-EFF-003 supersession is atomic | 4 | One transaction in the domain (`ADR-0005`) |
| INV-EFF-006 no `is_current` flag | **1** | No such column exists; resolution is a range containment query |
| INV-EFF-007 exactly one effectivity event | 2 | `unique (tenant_id, dedupe_key)` on `audit_event` |
| INV-APR-001 decisions name an exact revision | **1** | `content_revision_id` and `content_digest` `not null` on every decision |
| INV-APR-007 decisions immutable | 2 | `revoke update, delete` from `app_role` |
| INV-APR-010 template versions immutable | 2 | `revoke update` on `workflow_template_version` |
| INV-APR-021 body distinguished from recorder | **1** | Separate `decided_by_type`/`decided_by_id` and `recorded_by_user_id`, both `not null` for body decisions |
| INV-APR-022 resolution date not before submission | 2 | `check (resolution_date is null or resolution_date >= submitted_at)` via trigger |
| INV-ATT-001 campaigns bind an exact version | **1** | `document_version_id not null`; no nullable "latest" path |
| INV-ATT-002 responses record the full context | **1** | Version, digest, statement and locale columns all `not null` |
| INV-ATT-007 responses append-only | 2 | `revoke update, delete` |
| INV-ATT-012 one assignment per principal | 2 | `unique (tenant_id, campaign_id, user_id)` |
| INV-REV-005 completed cases immutable | 2 | Trigger refusing `update` once `completed_at` is set |
| INV-REV-006 one open case per rule | 2 | Partial unique index on open states |
| INV-AUD-002 ledger append-only | 2 | `revoke update, delete, truncate` from `app_role` |
| INV-AUD-005 required envelope fields | **1** | All `not null` columns, not `jsonb` keys |
| INV-AUD-009 deterministic total order | 2 | Gapless per-tenant sequence under a row lock (`ADR-0006`) |
| INV-APL-011 exactly one baseline variant | 2 | Partial unique index on `variant_type = 'BASELINE'` |
| INV-CFG-003 configuration recorded with the action | **1** | `configuration_version_id not null` on every governed record |
| INV-TIME-001 UTC everywhere | 3 | `timestamptz` only; no `timestamp` column exists |
| INV-TIME-003 optimistic concurrency | 2 | `row_version` with a conflict-raising update |
| INV-TIME-005 half-open intervals | 3 | `tstzrange` constructed `[)` in generated columns |
| INV-AUTH-016 capabilities are a closed set | 3 | `capability` enum type |

### Deliberately below level 2

Recorded here so the gaps are visible rather than assumed.

| Invariant | Reached | Why not higher |
|---|---:|---|
| INV-APL-001 deterministic resolution | 5 | An algorithm's determinism is not expressible as a constraint. Property-based tests instead |
| INV-APL-003 equal-specificity collision | 4 | Applicability overlap is set intersection, not range overlap. Publication-time check plus the fail-closed reader path (`ADR-0005`) |
| INV-AUTH-001 default deny | 4 | Per-principal, per-resource authorization is not a table constraint. One evaluator (`ADR-0003`) |
| INV-AUTH-002 deny defeats allow | 4 | Same |
| INV-AUTH-003 expiry at check time | 4 | Same. The validity range is stored; the evaluation is code |
| INV-EFF-003 atomic supersession | 4 | Transaction boundary, not a constraint |
| INV-EVD-006 pack determinism | 4 | A property of the assembly pipeline (`ADR-0008`) |
| INV-VER-014 materiality is human | 5 | "A human decided this" is not expressible in a schema |

---

## Enum types

```sql
create type document_lifecycle   as enum ('PLANNED','ACTIVE','RETIRED');

create type version_lifecycle    as enum ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED',
                                          'PUBLISHED','EFFECTIVE','SUPERSEDED','WITHDRAWN',
                                          'REJECTED','CANCELLED');

create type variant_type         as enum ('BASELINE','REPLACEMENT','SUPPLEMENT','TRANSLATION');
create type materiality          as enum ('EDITORIAL','NON_MATERIAL','MATERIAL','EMERGENCY');
create type inheritance_mode     as enum ('MANDATORY','DEFAULT','LOCAL_ONLY');

create type completion_rule      as enum ('ALL','ANY_ONE','AT_LEAST_N','BODY_RESOLUTION');
create type approval_decision_kind as enum ('APPROVE','REQUEST_CHANGES','REJECT');
create type run_status           as enum ('RUNNING','BLOCKED','COMPLETED','CHANGES_REQUESTED',
                                          'REJECTED','CANCELLED');

create type review_outcome       as enum ('NO_CHANGE','CHANGE_REQUIRED','SCOPE_CHANGE_REQUIRED',
                                          'RETIREMENT_RECOMMENDED');

create type assignment_state     as enum ('PENDING','COMPLETED','COMPLETED_LATE','DECLINED',
                                          'EXEMPTED','CANCELLED_DEPARTURE','CANCELLED_CAMPAIGN');

create type grant_effect         as enum ('ALLOW','DENY');
create type scope_type           as enum ('TENANT','LEGAL_ENTITY','ORG_UNIT','DOCUMENT',
                                          'DOCUMENT_VARIANT','DOCUMENT_VERSION',
                                          'GOVERNANCE_BODY');
create type capability           as enum ('document.read','document.read_history', /* … */);
```

`version_lifecycle` has no `SCHEDULED` and no `ARCHIVED`, and `assignment_state` has no
`DUE_SOON` and no `OVERDUE`. Those are derived conditions, per `document-lifecycle.md` and
`consolidation-notes.md` refinements 15 and 16. A derived condition given a stored value
is a second source of truth that can disagree with the first.

`scope_type` has no `SPACE` (INV-AUTH-015).

---

## Tenancy and identity

```sql
create table tenant (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  status                  text not null,
  default_timezone        text not null,
  default_locale          text not null,
  residency_profile       text not null,
  governance_profile_code text,             -- provenance only; never a live link (INV-CFG-002)
  created_at              timestamptz not null default now()
);
```

`tenant` is the one table without `tenant_id` and without RLS — it is the root.

```sql
create table app_user (                     -- `user` is reserved
  … standard tenant-owned columns …
  external_identity_id  text,               -- IdP subject, V1
  display_name          text not null,
  contact_email         text not null,
  status                text not null,      -- INVITED | ACTIVE | DEACTIVATED
  locale                text,
  timezone              text,
  deactivated_at        timestamptz,
  unique (tenant_id, lower(contact_email)),
  unique (tenant_id, external_identity_id)
);
```

Deactivation sets `status` and `deactivated_at`. There is no delete path: historical
attribution outlives the person (INV-AUTH-014), and erasure obligations are met by
pseudonymising `display_name` and `contact_email` while the row and its identifier survive
(INV-RET-004).

| Table | Columns |
|---|---|
| `user_credential` | `user_id`, `kind` (`PASSWORD`, `OIDC`, `SAML`), `secret_hash`, `params jsonb`, `rotated_at`. Separated from the principal so V1 identity is additive (`ADR-0002`) |
| `user_session` | `user_id`, `token_hash`, `issued_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `user_agent_class`. Deleted on deactivation |
| `user_group` | `name`, `source` (`LOCAL`, `SCIM`), `external_id`, `status`. `unique (tenant_id, lower(name))` |
| `group_membership` | `group_id`, `user_id`, `validity tstzrange`. `unique (tenant_id, group_id, user_id, validity)` |

## Organisation

```sql
create table legal_entity (
  … standard tenant-owned columns …
  legal_name              text not null,
  registration_number     text,
  country_of_registration text,             -- never implies jurisdiction (INV-ORG-004)
  parent_legal_entity_id  uuid,
  status                  text not null,
  closed_at               timestamptz,
  foreign key (tenant_id, parent_legal_entity_id)
    references legal_entity (tenant_id, id) on delete restrict,
  check (id <> parent_legal_entity_id)
);

-- INV-ORG-001: the self-reference check catches a one-cycle; longer cycles need
-- a recursive check, which is a trigger rather than a constraint.
create trigger legal_entity_acyclic
  before insert or update of parent_legal_entity_id on legal_entity
  for each row execute function assert_no_cycle('legal_entity', 'parent_legal_entity_id');
```

`org_unit` has the same shape plus `legal_entity_id` and the same acyclicity trigger.

| Table | Columns |
|---|---|
| `jurisdiction` | `code`, `name`, `level`, `status`. `unique (tenant_id, code)` |
| `org_membership` | `user_id`, `legal_entity_id`, `org_unit_id`, `validity tstzrange`, `is_primary`, `jurisdiction_ids uuid[]`. `revoke delete` — INV-ORG-002 |
| `governance_body` | `code`, `name`, `legal_entity_id`, `parent_body_id`, `quorum_rule`, `status`. `unique (tenant_id, code)` |
| `body_membership` | `body_id`, `user_id`, `seat_role`, `validity tstzrange` |
| `space` | `name`, `code`, `owning_org_unit_id`, `status`. Administrative grouping only — it appears in no authorization or applicability path (INV-AUTH-015, INV-APL-010) |

## Authorization

```sql
create table access_grant (
  … standard tenant-owned columns …
  effect          grant_effect not null,
  principal_type  text not null,            -- USER | GROUP | API_CLIENT
  principal_id    uuid not null,
  security_role_id uuid,
  capability      capability,
  scope_type      scope_type not null,
  scope_id        uuid,                     -- null only when scope_type = 'TENANT'
  validity        tstzrange not null default tstzrange(now(), null, '[)'),
  granted_by      uuid not null,
  reason          text,

  -- a grant confers a role's bundle or one capability, never both and never neither
  check (num_nonnulls(security_role_id, capability) = 1),
  -- INV-AUTH-002/003: a deny and a time-bounded grant both require a recorded reason
  check (effect = 'ALLOW' or reason is not null),
  check (upper_inf(validity) or reason is not null),
  check ((scope_type = 'TENANT') = (scope_id is null))
);
```

`scope_id` is intentionally **not** a foreign key: it points at one of six tables. The
alternative — six nullable columns with six composite foreign keys — is more correct and
considerably more painful, and it was weighed. The polymorphic column wins on the grounds
that a dangling scope reference fails closed (the evaluator finds no resource and denies),
whereas the six-column form would be a permanent tax on every read of this table.
Referential integrity is asserted by a scheduled consistency check rather than by the
database.

| Table | Columns |
|---|---|
| `security_role` | `code`, `name`, `capabilities capability[]`, `is_system`. `unique (tenant_id, code)` |
| `access_request` | `requester_id`, `scope_type`, `scope_id`, `capability`, `justification`, `requested_until`, `status`, `decided_by`, `decided_at`, `decision_reason`, `resulting_grant_id` |
| `breakglass_session` | `actor_id`, `started_at`, `expires_at`, `justification`, `approved_by`, `scope_type`, `scope_id`, `ended_at`, `end_reason` |

## Configuration

| Table | Columns |
|---|---|
| `configuration_version` | `sequence`, `effective_from`, `changed_by`, `change_reason`, `weakening boolean`, `payload_digest`. `unique (tenant_id, sequence)` |
| `document_type` | `code`, `name`, `rank`, `mandated_authority jsonb`, `default_workflow_template_id`, `default_review_rule jsonb`, `requires_attestation_by_default`, `mandated_by_document_version_id`, `status`. `unique (tenant_id, code)`, `unique (tenant_id, rank)` |
| `information_classification` | `code`, `name`, `rank`, `handling_instructions`, `externally_disclosable boolean`, `status`. `unique (tenant_id, code)`, `unique (tenant_id, rank)`. Referenced by `document_version.classification_id`; referenced by no authorization structure at all (INV-AUTH-019) |
| `attestation_statement` | `statement_key`, `version_sequence`, `locale`, `body`, `created_by`. `unique (tenant_id, statement_key, version_sequence, locale)`, `revoke update` |
| `retention_rule` | `record_class`, `duration interval`, `anchor`, `disposition`. `unique (tenant_id, record_class)` |
| `legal_hold` | `reason`, `authorised_by`, `legal_owner`, `scope_selector jsonb`, `started_at`, `review_at`, `released_at` |

## Documents

```sql
create table document (
  … standard tenant-owned columns …
  document_code       text not null,
  canonical_title     text not null,
  document_type_id    uuid not null,              -- authoritative for type (INV-DOC-005)
  owner_user_id       uuid,                       -- nullable: an unowned document is a
                                                  -- visible exception (INV-DOC-006)
  owning_org_unit_id  uuid not null,              -- administrative containment (INV-AUTH-017)
  space_id            uuid,
  lifecycle_status    document_lifecycle not null default 'PLANNED',
  is_governing_framework boolean not null default false,
  retired_at          timestamptz,
  retirement_reason   text,

  unique (tenant_id, document_code),
  foreign key (tenant_id, document_type_id)   references document_type (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, owning_org_unit_id) references org_unit (tenant_id, id)
    on delete restrict,
  check ((lifecycle_status = 'RETIRED') = (retired_at is not null)),
  check (lifecycle_status <> 'RETIRED' or retirement_reason is not null)
);

-- INV-DOC-008: retirement is bookkeeping after withdrawal, never a way to end
-- what governs people.
create trigger document_no_retire_while_effective
  before update of lifecycle_status on document
  for each row when (new.lifecycle_status = 'RETIRED')
  execute function assert_no_effective_version();
```

```sql
create table document_variant (
  … standard tenant-owned columns …
  document_id       uuid not null,
  variant_type      variant_type not null,
  source_variant_id uuid,                    -- null only for BASELINE
  locale            text,                    -- required for TRANSLATION
  status            text not null,

  foreign key (tenant_id, document_id) references document (tenant_id, id)
    on delete restrict,                      -- INV-DOC-004
  check ((variant_type = 'BASELINE') = (source_variant_id is null)),
  check (variant_type <> 'TRANSLATION' or locale is not null)
);

-- INV-APL-011: exactly one baseline per document, created with it and never deleted.
create unique index one_baseline_per_document
  on document_variant (tenant_id, document_id)
  where variant_type = 'BASELINE';
```

```sql
create table document_version (
  … standard tenant-owned columns …
  document_variant_id      uuid not null,
  version_sequence         integer not null,
  display_label            text,             -- never identity, never ordering (INV-VER-006)
  lifecycle_state          version_lifecycle not null default 'DRAFT',
  document_type_id         uuid not null,    -- as at submission (INV-DOC-009)
  title                    text not null,    -- as at submission (INV-DOC-010)
  classification_id        uuid not null,    -- as at submission (INV-AUTH-019)
  approved_revision_id     uuid,
  content_digest           text,
  materiality              materiality,
  change_summary           text,
  approved_at              timestamptz,
  published_at             timestamptz,
  effective_from           timestamptz,
  effective_until          timestamptz,
  superseded_by_version_id uuid,
  withdrawn_at             timestamptz,
  withdrawal_reason        text,
  configuration_version_id uuid,             -- not null from APPROVED onward

  -- tstzrange(null, null) is (,) — unbounded, not null. Without the case a
  -- pre-release version would claim all of time. Verified 2026-08-25; see ADR-0005.
  effective_range tstzrange generated always as (
    case when effective_from is null then null
         else tstzrange(effective_from, effective_until, '[)')
    end) stored,

  unique (tenant_id, document_variant_id, version_sequence),   -- INV-VER-011
  foreign key (tenant_id, document_variant_id)
    references document_variant (tenant_id, id) on delete restrict,

  check (lifecycle_state <> 'WITHDRAWN' or withdrawal_reason is not null),
  check (effective_until is null or effective_from is not null)
);

-- INV-EFF-002: at most one version of a variant claims any instant.
-- The interval is claimed at publication, so a scheduling collision is refused
-- while a human is looking at it rather than at midnight (ADR-0005).
alter table document_version add constraint one_effective_version_per_variant
  exclude using gist (
    tenant_id           with =,
    document_variant_id with =,
    effective_range     with &&
  ) where (effective_range is not null);

-- INV-VER-012: at most one pre-release version per variant.
create unique index one_pre_release_version_per_variant
  on document_version (tenant_id, document_variant_id)
  where lifecycle_state in ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED');

-- INV-VER-003 and INV-VER-007: governed columns are frozen from APPROVED onward.
-- Administrative columns are deliberately absent from this list (INV-VER-008).
create trigger document_version_governed_columns_immutable
  before update on document_version
  for each row execute function assert_governed_columns_unchanged();
```

There is no `is_current` column, and there is no view that materialises one. Resolution is
a range containment query (INV-EFF-006, `ADR-0005`).

```sql
create table content_revision (
  … standard tenant-owned columns …
  document_version_id             uuid not null,
  revision_sequence               integer not null,
  content_ref                     text,      -- object key of the controlled file
  canonical_manifest              jsonb not null,
  canonicalisation_schema_version integer not null,
  content_digest                  text not null,
  created_by                      uuid not null,
  submitted_at                    timestamptz,

  unique (tenant_id, document_version_id, revision_sequence),
  foreign key (tenant_id, document_version_id)
    references document_version (tenant_id, id) on delete restrict
);

-- INV-VER-002: submission freezes exactly one revision per version.
create unique index one_submitted_revision_per_version
  on content_revision (tenant_id, document_version_id)
  where submitted_at is not null;

-- INV-VER-010: a submitted revision is immutable; editing creates revision n+1.
create trigger content_revision_immutable_after_submission
  before update on content_revision
  for each row when (old.submitted_at is not null)
  execute function reject_update();
```

| Table | Columns |
|---|---|
| `content_attachment` | `content_revision_id`, `filename`, `media_type`, `byte_size`, `storage_ref`, `digest`. No "reference only" column exists, because every attachment is governed content (INV-VER-013) |
| `applicability_rule` | `document_variant_id`, `effect`, `legal_entity_ids uuid[]`, `org_unit_ids uuid[]`, `jurisdiction_ids uuid[]`, `group_ids uuid[]`, `user_ids uuid[]`, `inheritance_mode`, `validity tstzrange` |
| `alignment_obligation` | `subject_type`, `subject_id`, `source_version_id`, `raised_at`, `due_at`, `reason`, `status`, `resolved_by`, `resolved_at`, `resolution_note`, `resolving_review_case_id`. Stored rather than derived, because INV-APL-008 requires a recorded action to clear it. `due_at` is nullable and never auto-resolves anything (INV-APL-013) |

## Approval

```sql
create table approval_decision (
  … standard tenant-owned columns …
  approval_task_id     uuid not null,
  decision             approval_decision_kind not null,
  decided_by_type      text not null,        -- USER | BODY
  decided_by_id        uuid not null,
  recorded_by_user_id  uuid not null,        -- INV-APR-021: never presented as the approver
  recorded_at          timestamptz not null default now(),
  content_revision_id  uuid not null,        -- INV-APR-001
  content_digest       text not null,
  reason_code          text,
  comment_ref          uuid,
  resolution_reference text,                 -- body-resolution evidence, per configuration
  resolution_date      date,
  minutes_attachment_id uuid,
  attending_members    uuid[],
  configuration_version_id uuid not null,    -- INV-APR-024

  check (decided_by_type <> 'BODY' or recorded_by_user_id is not null)
);

-- INV-APR-007: decisions are immutable; corrections are compensating events.
revoke update, delete on approval_decision from app_role;

-- INV-APR-022: a body cannot have resolved on text that did not yet exist.
create trigger approval_decision_resolution_date_valid
  before insert on approval_decision
  for each row execute function assert_resolution_date_after_submission();
```

| Table | Columns |
|---|---|
| `workflow_template` | `name`, `purpose`, `active_version_id`, `status` |
| `workflow_template_version` | `workflow_template_id`, `version_sequence`, `stages jsonb`, `separation_of_duties_rules jsonb`, `published_at`, `published_by`. `revoke update` — INV-APR-010 |
| `approval_run` | `content_revision_id`, `workflow_template_version_id`, `resolved_participants jsonb`, `status run_status`, `started_at`, `completed_at`, `cancelled_reason`, `configuration_version_id`. `resolved_participants` is frozen at start — INV-APR-012 |
| `approval_stage` | `approval_run_id`, `stage_order`, `completion_rule`, `threshold`, `status`, `due_at`, `completed_at`. `unique (tenant_id, approval_run_id, stage_order)` |
| `approval_task` | `approval_stage_id`, `participant_type`, `participant_id`, `status`, `assigned_at`, `due_at`, `delegated_from_user_id` |

## Review

| Table | Columns |
|---|---|
| `review_rule` | `document_variant_id`, `cadence_months`, `fixed_calendar_date`, `anchor`, `event_triggers text[]`, `reminder_offsets interval[]`, `escalation_offsets interval[]`, `owner_user_id`, `secondary_reviewer_id`, `status` |
| `review_case` | `review_rule_id`, `trigger`, `document_version_id`, `due_at`, `started_at`, `completed_at`, `status`, `outcome review_outcome`, `completed_by`, `rationale`, `resulting_version_id`, `configuration_version_id` |

```sql
-- INV-REV-006: at most one open case per rule; rescheduling never creates a second.
create unique index one_open_review_case_per_rule
  on review_case (tenant_id, review_rule_id)
  where status in ('SCHEDULED','IN_PROGRESS');

-- INV-REV-005: a completed case is evidence.
create trigger review_case_immutable_once_completed
  before update on review_case
  for each row when (old.completed_at is not null) execute function reject_update();

-- INV-REV-007
alter table review_case
  add constraint completed_case_names_a_version
  check (completed_at is null or (document_version_id is not null
                                  and configuration_version_id is not null
                                  and rationale is not null));
```

## Attestation

| Table | Columns |
|---|---|
| `attestation_campaign` | `document_version_id` **not null** (INV-ATT-001), `audience_definition jsonb`, `audience_mode`, `enrolment_window_end`, `attestation_statement_id`, `launch_at`, `due_at`, `closed_at`, `status`, `owner_user_id`, `origin_reason`, `configuration_version_id` |
| `attestation_assignment` | `campaign_id`, `user_id`, `state assignment_state`, `targeting_basis jsonb` (INV-ATT-004), `due_at`, `exempted_by`, `exemption_reason`, `exemption_expires_at` |
| `attestation_response` | `assignment_id`, `response_type`, `responded_at`, `document_version_id`, `content_digest`, `attestation_statement_id`, `locale_presented`, `responder_user_id`, `session_assurance` |

```sql
-- INV-ATT-012: one obligation per principal per campaign, however many
-- clauses of an audience rule caught them.
alter table attestation_assignment
  add constraint one_assignment_per_principal unique (tenant_id, campaign_id, user_id);

-- INV-ATT-007: a correction adds evidence rather than replacing it.
revoke update, delete on attestation_response from app_role;

-- INV-ATT-002: the response is the evidence, so its context is not optional.
alter table attestation_response
  alter column document_version_id      set not null,
  alter column content_digest           set not null,
  alter column attestation_statement_id set not null,
  alter column responded_at             set not null;
```

`COMPLETED_LATE` is stored rather than derived because a deadline can legitimately be
extended afterwards and the fact of lateness must not move with it (INV-ATT-003,
INV-ATT-011).

## Waivers

| Table | Columns |
|---|---|
| `waiver` | `document_id`, `document_version_id`, `subject_scope jsonb`, `rationale`, `compensating_controls`, `owner_user_id`, `approved_by`, `approved_at`, `status`, `expires_at`, `next_review_at`. `check (status <> 'APPROVED' or expires_at is not null)` — a waiver without an expiry is a defect |

## Audit and evidence

```sql
create table tenant_event_sequence (
  tenant_id     uuid primary key references tenant(id),
  next_sequence bigint not null default 1
);

create table audit_event (
  tenant_id                uuid not null references tenant(id),
  event_id                 uuid not null default gen_random_uuid(),
  sequence                 bigint not null,          -- gapless, commit-ordered (ADR-0006)
  event_type               text not null,
  event_schema_version     integer not null,
  occurred_at              timestamptz not null,
  recorded_at              timestamptz not null default now(),
  actor_type               text not null,
  actor_id                 uuid,
  originating_actor_id     uuid,
  elevation_session_id     uuid,
  subject_type             text not null,
  subject_id               uuid not null,
  document_id              uuid,
  document_variant_id      uuid,
  document_version_id      uuid,
  action                   text not null,
  outcome                  text not null,
  reason_code              text,
  request_id               uuid,
  correlation_id           uuid not null,
  source_channel           text not null,
  safe_before              jsonb,
  safe_after               jsonb,
  configuration_version_id uuid,
  corrects_event_id        uuid,
  dedupe_key               text,

  primary key (tenant_id, sequence),
  unique (event_id),
  unique (tenant_id, dedupe_key),                    -- INV-AUD-001, INV-EFF-007
  check (pg_column_size(safe_before) + pg_column_size(safe_after) < 8192)
);

-- INV-AUD-002: append-only through every application surface.
-- retention_role holds delete separately, for disposal under a customer's
-- configured schedule and never otherwise (ADR-0006, ADR-0009).
revoke update, delete, truncate on audit_event from app_role;
```

The envelope fields INV-AUD-005 requires are columns, not `jsonb` keys, so a missing one
is a constraint violation rather than a discovery during an audit. Family-specific
attributes live in `safe_before`/`safe_after` under a size check and write-time schema
validation (INV-AUD-003, INV-AUD-008).

| Table | Columns |
|---|---|
| `evidence_pack` | `pack_type`, `request_parameters jsonb`, `as_of`, `generated_at`, `requested_by`, `privacy_profile`, `status`, `manifest_digest`, `storage_ref`, `download_expires_at`. Availability is this row, never the presence of an object (`ADR-0008`) |
| `notification` | `template_code`, `recipient_id`, `channel`, `triggering_event_id`, `sent_at`, `delivery_status`, `failure_reason`, `idempotency_key`. Operational, never authoritative governance state |

## Integration and later

| Table | Phase | Note |
|---|---|---|
| `api_client` | V1 | `name`, `status`, `credential_metadata jsonb`. Identity and credentials only — **no capability or scope columns**. A machine principal holds `access_grant` rows like every other principal, and is authorised by the same evaluator (INV-AUTH-010, INV-AUTH-018) |
| `webhook_subscription` | V1 | `endpoint_url`, `event_types text[]`, `signing_key_ref`, `status`, `cursor_sequence` — the cursor over `audit_event` from `ADR-0006` |
| `document_relationship` | Later | `source_document_id`, `target_document_id`, `relation`, `rationale` |
| `external_reference` | Later | `document_id`, `source_type`, `identifier`, `citation jsonb` |

Every entity in `domain-model.md` is present. The four above are created by migration in
the phase noted, so the schema does not have to be retrofitted, and carry no behaviour
until then.

---

## Indexes

Two rules, then the specifics.

**Every index leads with `tenant_id`.** Row-level security adds `tenant_id = …` to every
query (`ADR-0001`), and an index that does not lead with it forces the planner to filter
after scanning. This is the single most consequential indexing decision in the schema.

**Every foreign key gets an index.** Postgres does not create them, and their absence
turns an `on delete restrict` check into a sequential scan — on a schema where restrict is
the mechanism behind INV-DOC-004 and INV-ORG-003.

| Index | Serves |
|---|---|
| `document_version` GiST `(tenant_id, document_variant_id, effective_range)` | The exclusion constraint **and** resolution. One structure, both jobs (`ADR-0005`) |
| `document (tenant_id, lifecycle_status, owning_org_unit_id)` | The register, and authorization scope containment |
| `document (tenant_id, owner_user_id) where owner_user_id is null` | Unowned documents, a governance exception surfaced constantly (INV-DOC-006) |
| `access_grant (tenant_id, principal_type, principal_id, scope_type, scope_id)` | The evaluator's hot path, which runs on every check (`ADR-0003`) |
| `access_grant (tenant_id, validity)` GiST | Expiry sweeps and the grants-expiring view |
| `audit_event (tenant_id, sequence)` | The primary key; also the cursor scan for outbound delivery |
| `audit_event (tenant_id, document_id, sequence)` | Evidence assembly for one document |
| `audit_event (tenant_id, correlation_id)` | Tracing one operation across events |
| `review_case (tenant_id, status, due_at)` | Due and overdue queues |
| `attestation_assignment (tenant_id, user_id, state)` | *My actions* — the reader's landing page |
| `attestation_assignment (tenant_id, campaign_id, state)` | Campaign completion |
| `approval_task (tenant_id, participant_id, status)` | *My approvals* |
| `org_membership (tenant_id, user_id, validity)` GiST | Point-in-time membership resolution (INV-APL-009) |
| `content_revision (tenant_id, document_version_id, revision_sequence)` | The drafting trail |

### Full-text search

A generated `tsvector` column on `document_version` over the title, change summary and
extracted text, with a GIN index.

Extracted text is a derived artefact (`ADR-0004`) and never enters the content digest —
but it is exactly what search needs. Storing it in a column keeps the index and the source
in one transaction, so there is no separate index to fall behind.

Authorization is still applied at retrieval over the candidate rows, never by trusting the
index (INV-AUTH-011). The index narrows; the evaluator decides.

## What this model deliberately does not have

| Absent | Why |
|---|---|
| `is_current`, `is_latest`, or any current-version flag | INV-EFF-006. Resolution is range containment |
| A `scheduled` or `archived` version state | Derived conditions (`consolidation-notes.md` 15–16) |
| A `due_soon` or `overdue` assignment state | Derived from `due_at` |
| A materialised effective-permissions table | A cache that would outlive grants (INV-AUTH-003, `ADR-0003`) |
| `SPACE` in `scope_type` | INV-AUTH-015 |
| Any classification column reachable from the evaluator's query path | INV-AUTH-019. `information_classification` is referenced by `document_version` and by nothing in `access_grant` |
| A "reference only" flag on attachments | INV-VER-013 |
| Down-migration artefacts | `ADR-0009` |
| Any `timestamp without time zone` | INV-TIME-001 |
| Hard-delete paths on governed tables | INV-DOC-004, INV-ORG-003. `on delete restrict` throughout |

## Open questions for implementation

Not decisions — things the first migrations will settle, recorded so they are settled
deliberately.

| Question | Note |
|---|---|
| `assert_no_cycle` implementation | A recursive `with` in a trigger is correct and costs a query per write on a rarely-written table. Materialising a path column is faster and adds a maintenance burden. Start with the trigger |
| Partitioning `audit_event` | Not now. Revisit by tenant or by month when volume justifies it; the gapless per-tenant sequence survives either |
| `jsonb` for `applicability_rule` targets versus join tables | Arrays are simpler and adequate for explicit audiences (open decision 5). Rule-based applicability in V1 may want join tables for indexed containment queries |
| `capability` enum growth | Every new capability is an `alter type` in a migration, which is the friction the closed set is meant to have |
| `attending_members uuid[]` on decisions | An array denormalises body membership at decision time, deliberately: membership changes later must not rewrite who attended |
| Text extraction storage | A column on `content_revision` or a side table. A side table keeps the governed row narrow and the extractor version easy to track |

## Verification

The exit criteria for this model, checkable rather than asserted:

- [ ] Every table in this document exists in the migration chain, and nothing exists in
  the
      chain that is not here
- [ ] Every level-1 and level-2 row of the enforcement map has a migration implementing
  it,
      with the invariant ID in a `comment on constraint`
- [ ] Every invariant in the "deliberately below level 2" table has the test that carries
  it
- [ ] CI's drift check passes: the schema built from migrations matches the Drizzle
      definition
- [ ] A cross-tenant negative test exists for every table with a `tenant_id`
- [ ] A schema test asserts that **every** table with a `tenant_id` column has row-level
      security both enabled and forced, and carries a tenant policy. A migration that adds a
      table and forgets this is the residual risk named in `threat-model.md`, and it is cheap
      to close
