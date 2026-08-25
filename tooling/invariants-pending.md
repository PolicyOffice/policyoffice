# Invariants not yet implemented

Every invariant in `docs/domain/invariants.md` must either be named by a test or appear
here. `tooling/invariant-coverage.ts` enforces that, and it is a required CI gate.

**This file only shrinks.** An entry is removed in the same pull request that adds the
test naming its invariant — the coverage check fails if an invariant is both tested and
still listed here, so a stale entry cannot survive.

Adding an entry is deliberately more visible in a diff than writing the test would have
been. That is the incentive, and it is the point of the file.

Format, parsed strictly:

```text
- INV-XXX-000 — reason, and the ticket that will implement it
```

## INV-TEN — Tenant isolation

- INV-TEN-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TEN-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TEN-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TEN-005 — MVP; no schema or domain code yet (Phase 2/3)

## INV-ORG — Organisational structure

- INV-ORG-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ORG-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ORG-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ORG-004 — V1; no schema or domain code yet (Phase 2/3)
- INV-ORG-005 — MVP; no schema or domain code yet (Phase 2/3)

## INV-DOC — Document identity and lifecycle

- INV-DOC-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-DOC-030 — V1; no schema or domain code yet (Phase 2/3)

## INV-VER — Versioning and immutability

- INV-VER-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-012 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-013 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-014 — MVP; no schema or domain code yet (Phase 2/3)
- INV-VER-015 — MVP; no schema or domain code yet (Phase 2/3)

## INV-EFF — Effectivity and supersession

- INV-EFF-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EFF-009 — V1; no schema or domain code yet (Phase 2/3)

## INV-APR — Approval

- INV-APR-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-010 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-011 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-012 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-013 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-014 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-020 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-021 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-022 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-023 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-024 — MVP; no schema or domain code yet (Phase 2/3)

## INV-CFG — Configuration

- INV-CFG-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-CFG-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-CFG-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-CFG-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-CFG-005 — V1; no schema or domain code yet (Phase 2/3)
- INV-CFG-006 — MVP; no schema or domain code yet (Phase 2/3)

## INV-AUTH — Authorization

- INV-AUTH-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-004 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-009 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-012 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-013 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-014 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-015 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-016 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-017 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-018 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-019 — MVP; no schema or domain code yet (Phase 2/3)

## INV-APL — Applicability and variants

- INV-APL-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APL-002 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-003 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-004 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-005 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-007 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-008 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-009 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APL-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APL-012 — V1; no schema or domain code yet (Phase 2/3)
- INV-APL-013 — V1; no schema or domain code yet (Phase 2/3)

## INV-REV — Review

- INV-REV-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-007 — MVP; no schema or domain code yet (Phase 2/3)

## INV-ATT — Attestation

- INV-ATT-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-009 — V1; no schema or domain code yet (Phase 2/3)
- INV-ATT-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-012 — MVP; no schema or domain code yet (Phase 2/3)

## INV-AUD — Audit

- INV-AUD-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUD-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUD-009 — MVP; no schema or domain code yet (Phase 2/3)

## INV-EVD — Evidence

- INV-EVD-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-007 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-008 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-010 — MVP; no schema or domain code yet (Phase 2/3)

## INV-RET — Retention and legal hold

- INV-RET-001 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-002 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-003 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-004 — V1; no schema or domain code yet (Phase 2/3)

## INV-TIME — Time and concurrency

- INV-TIME-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TIME-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TIME-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TIME-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-TIME-005 — MVP; no schema or domain code yet (Phase 2/3)
