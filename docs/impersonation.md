# SUPER_ADMIN impersonation — design (NOT implemented in Phase 1)

Goal: let a SUPER_ADMIN see and operate the platform exactly as another user does
(e.g. to reproduce a merchant's problem) without knowing their password, while keeping a
complete, tamper-evident record of who really did what.

## Principles

1. **Two identities per request.** Every impersonated request carries the _effective user_
   (whose permissions apply) and the _actor_ (the SUPER_ADMIN). Authorization uses the
   effective user; auditing always records the actor.
2. **Explicit, temporary, visible.** Impersonation is started deliberately, expires quickly,
   and every UI shows a persistent banner while it is active.
3. **Least privilege.** An impersonation session can never do more than the target user, and
   some sensitive operations are blocked entirely.

## Data model (future migration)

```prisma
model ImpersonationSession {
  id              String    @id @default(uuid(7)) @db.Uuid
  actorUserId     String    @db.Uuid      // the SUPER_ADMIN
  targetUserId    String    @db.Uuid      // the user being impersonated
  reason          String                  // mandatory free-text justification
  ticketReference String?
  sessionId       String    @unique @db.Uuid  // the temporary Session row it created
  startedAt       DateTime  @default(now())
  expiresAt       DateTime                // e.g. startedAt + 30 minutes, not extendable
  endedAt         DateTime?
  endedReason     String?                 // MANUAL | EXPIRED | ACTOR_LOGOUT | REVOKED
}
```

`Session` gains `impersonationId String? @unique`. `AuditLog` gains
`effectiveUserId String?` and `impersonationId String?` (`actorUserId` already exists and
always holds the real human).

## Flow

1. `POST /v1/admin/impersonations { targetUserId, reason, ticketReference? }`
   - Requires SUPER_ADMIN, a verified email, and **step-up re-authentication**
     (password re-entry, later TOTP) within the last 5 minutes.
   - Refused if the target is a SUPER_ADMIN, is disabled, or is the actor.
   - Creates a **new, separate session** (never reuses the target's sessions), bound to the
     target's `clientApp`, with a short absolute expiry (default 30 minutes) and no renewal.
   - Writes `IMPERSONATION_STARTED` to the audit log (actor, target, reason, IP, user agent).
2. The admin console opens the target experience (merchant/driver web app or admin view)
   with the temporary session. The actor's own session stays untouched.
3. Every request in that session resolves `request.auth` as
   `{ user: target, actor: superAdmin, impersonationId }`.
4. `POST /v1/admin/impersonations/:id/end` (or expiry, or the actor logging out) revokes the
   temporary session and writes `IMPERSONATION_ENDED`.

## Restrictions while impersonating

Blocked with `403 IMPERSONATION_FORBIDDEN_ACTION` (enforced by a guard decorator such as
`@DenyDuringImpersonation()` on the route, not by the UI):

- Changing password, email, phone, or any credential; password-reset/verification flows.
- Creating/revoking the target's other sessions; logging the target out elsewhere.
- Financial operations once they exist: payouts, withdrawals, bank details, refunds,
  settlement approval, invoice finalisation.
- Accepting legal terms, deleting the account, exporting personal data.
- Starting another impersonation (no nesting) or any admin endpoint.

Read access and normal operational actions (e.g. viewing shipments, creating a draft shipment
on the merchant's behalf) are allowed but always audited with both identities.

## Auditing

- Every audit entry written during impersonation stores `actorUserId` (SUPER_ADMIN),
  `effectiveUserId` (target) and `impersonationId`.
- Domain records that keep "created by"/"updated by" columns store the **actor**, plus the
  impersonation id, never only the target.
- Audit logs are append-only (no update/delete API; in production, a DB role without
  `UPDATE/DELETE` on `audit_logs`).
- The target user can be notified (email/in-app) that support accessed their account.

## UI

- Persistent, high-contrast banner in both languages: "You are acting as {name} — End".
- Distinct browser tab title / app header colour.
- Countdown to expiry; ending returns the SUPER_ADMIN to the admin console.

## Why it is not implemented yet

Phase 1 delivers the prerequisites — server-side revocable sessions, a `clientApp`-bound
session model, a global guard with decorators, and an audit log with an explicit actor —
so impersonation can be added without changing the authentication design.
