# ADR-0002: Identity and sessions

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

The Pilot ships local accounts; Commercial V1 adds OIDC, SAML and SCIM. The risk is not
that local accounts are hard — it is that the shape chosen now makes enterprise identity a
rewrite instead of an addition.

One invariant does most of the deciding:

> **INV-AUTH-014 — Deactivating a user revokes active sessions and prevents new governed
> actions, while historical attribution is preserved.**

*"Offboarding must be immediate and non-destructive."* And in V1, the same requirement
arrives from outside: an IdP-deprovisioned user must lose access without anyone in the
product taking an action.

## Decision

### Server-side sessions in Postgres. Not JWTs.

A session is a row. The cookie carries an opaque, high-entropy identifier and nothing
else. Every request loads the session and re-checks that the principal is still active.

This is the unfashionable choice and it follows directly from INV-AUTH-014. A stateless
token cannot be revoked; it can only be denied by a revocation list, which is a session
store with worse ergonomics and a window of exposure equal to the token's remaining
lifetime. Deactivating a user has to be immediate, and the honest way to be immediate is
to delete the rows.

The same argument covers INV-AUTH-004 — *an expired grant cannot be prolonged by a cached
session or open page* — and the temporary-access case in `authorization-model.md`, where
an external auditor's access must stop at expiry without a logout.

| Property | Value |
|---|---|
| Identifier | Opaque random token, stored hashed. A leaked database backup does not yield usable sessions |
| Idle timeout, absolute lifetime | Both enforced, both tenant-configurable within product-set bounds |
| Revocation | Delete the row. Effective on the next request, with no cache to wait for |
| On deactivation | All of the principal's sessions deleted in the same transaction, and `session.revoked` emitted |
| Cookie | `HttpOnly`, `Secure`, `SameSite=Lax`, host-scoped |

Sessions live in the tenant-owned schema and are subject to ADR-0001 like everything else.

### Passwords, for the Pilot only

Argon2id, per-user salt, parameters recorded in configuration so they can be raised
without a schema change. Password reset by single-use, short-lived, hashed token. Rate
limiting and lockout on authentication attempts, with failures going to security logging
rather than the evidence ledger (INV-AUD-007).

No password policy theatre: length floor, a breached-password check where one can be done
offline, and no forced rotation.

**Local passwords are a Pilot mechanism and a V1 fallback, not the enterprise path.** Once
SSO exists, a tenant can require it, and local credentials survive only as the break-glass
administrative route that the V1 acceptance criteria demand — *"an SSO outage has a
documented, audited administrative recovery path."*

### The shape that keeps V1 additive

Three rules, chosen now, that determine whether enterprise identity is an addition or a
rewrite:

**1. Authentication is separated from the principal.** `User` holds identity and status;
credentials are a separate concern keyed to it. Adding an OIDC subject, a SAML assertion
or a SCIM-provisioned account means adding a credential kind, not changing the principal.
`User.external_identity_id` already exists in `domain-model.md` for exactly this.

**2. The identity provider never owns authorization.** IdP groups map to product `Group`
records; grants are made in the product, explicitly, and are audited. An IdP administrator
adding themselves to a group must not thereby acquire the capability to approve documents.
This is INV-AUTH-001 and INV-AUTH-016 holding the line, and it is the most common way SCIM
integrations quietly become a privilege-escalation path.

**3. Provisioning never rewrites history.** SCIM deprovisioning deactivates; it does not
delete. Completed decisions and responses stay attributed (INV-AUTH-014, INV-ATT-005), and
an IdP that stops mentioning a user is not an instruction to remove them from the record.

### Multi-factor authentication

Not in the Pilot. In V1 it is delegated to the customer's IdP, which is where it belongs —
buyers already pay Entra, Google or Okta partly to own this. Local accounts get MFA only
if a design partner needs local accounts in production, which would itself be a signal
that something went wrong with the SSO plan.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Stateless JWT sessions** | Cannot satisfy INV-AUTH-014 without a revocation list, which is a session store that also lies about being stateless. The window of exposure is the token lifetime, and shortening the lifetime just makes refresh the new problem |
| **A hosted auth provider** | Faster to ship and it moves the identity of every customer's employees to a third party, inside a residency commitment that says one EU region, complete (decision 7). It also puts a paid dependency on the critical path, which the budget posture makes a Decision Request |
| **Magic links only** | Pleasant, and it makes email availability a hard dependency of every governed action. A compliance officer locked out during an audit is the wrong failure |
| **SSO in the Pilot** | No design partner IdP to build against yet, and the Pilot's job is to prove the governance loop. Building it blind produces an integration that fits nobody |
| **IdP groups mapped directly to roles** | The tempting shortcut, and the one that lets whoever administers the directory grant themselves approval authority |

## Consequences

### What becomes easier

- Deactivation is genuinely immediate, and the test asserting it is trivial to write.
- Expiring access — auditors, temporary grants, break-glass — works without a cache to
  reason about.
- Enterprise identity becomes an added credential kind rather than a change to the
  principal model.

### What becomes harder

- **A database read on every request.** Cheap and indexed, but it is a read, and it makes
  the database a hard dependency of authentication rather than a soft one.
- **Horizontal scaling assumes a shared database**, which the modular monolith already
  does.
- **We own password handling** for the Pilot, including reset flows, lockout and the
  breached-password check. This is a well-understood but non-trivial surface, and it is
  the part of this ADR most worth reviewing carefully when it is implemented.

### What we have committed to maintaining

- Session revocation as a first-class operation, not a side effect.
- The separation between authentication and authorization: nothing an identity provider
  says may become a capability without an explicit, audited grant.

### Cost of reversing this

Low. Sessions are an internal mechanism behind one interface, and moving to a different
scheme later touches authentication, not the domain. The expensive thing to get wrong is
rule 2 — letting the IdP own authorization — because unwinding that means re-deriving
every grant in every tenant.

## To verify at repository bootstrap

- Argon2id parameters appropriate to the deployment target's CPU allocation, measured
  rather than copied from a blog post.
- Whether an offline breached-password check is feasible within the free tier, or whether
  it needs a Decision Request.
- Session-table read cost under the RLS policy from ADR-0001, since it is on every
  request.
