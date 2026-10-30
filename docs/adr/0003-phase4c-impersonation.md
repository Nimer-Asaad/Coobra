# ADR 0003 — Phase 4C: SUPER_ADMIN impersonation of merchant and driver accounts

- Status: **accepted** (owner-approved on 2026-10-30): decisions D1–D14, rules R1–R4 and the
  security design, with the owner's mandatory refinements to R1 (§10.2), R2 (§10.3), the
  notification outbox (§13) and database integrity (§7, §17). Phase 4C.1 (schema, contracts and
  route classification) is implemented on `feature/phase4c-impersonation`; impersonation is not
  enabled. Each later phase needs the owner's approval.
- Scope: adds impersonation on top of Phase 1 sessions, Phase 4A user management and the Phase 4B
  audit log. ADR 0001 and ADR 0002 are unchanged: no existing business rule changes for requests
  made outside impersonation, and the accountant-only cash workflow (ADR 0002 §1) is untouched.
- Supersedes the Phase 1 sketch in [docs/impersonation.md](../impersonation.md), which now
  summarises this ADR.

## 1. Goal and principle

A SUPER_ADMIN may temporarily operate a MERCHANT or DRIVER account to give support, and the app
behaves like that account. **Full operational access, no financial authority:** an impersonated
request can do the target's shipment work, but it never posts to the ledger, never declares or
counts cash, never gives financial consent and never changes pricing configuration. Where an
audited admin route already exists for something, support uses that route instead.

## 2. Identity model

| Identity                            | Holds                                                                            | Used for                                                                                    | Never used for                |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| **Real actor** (`actor`)            | The SUPER_ADMIN user, role, and the admin session started from                   | Every "done by" column, audit `actorUserId`, maker-checker comparisons, rate limits         | Data scoping, role rules      |
| **Effective account** (`principal`) | The target MERCHANT or DRIVER user and role                                      | `@Roles`, scoping (`merchantId`, `driverId`), the shipment transition actor, business rules | "Done by" attribution         |
| **Impersonation session**           | An `ImpersonationSession` row                                                    | Stamped on audit and operational history; re-validated on every request                     | —                             |
| **Financially accountable party**   | The owner of the ledger account, taken from the record (`merchantId`/`driverId`) | Ledger postings (none happen during impersonation)                                          | Derivation from the requester |

`RequestAuth` gains `principal`, `actor` and `impersonation`; merchant and driver services take an
`ActingContext { principal, actor, impersonation }` instead of one `Actor`. Outside impersonation
`actor` and `principal` are the same user, so behaviour is unchanged. The context is also placed
in an `AsyncLocalStorage` request context so that `AuditService` stamps both identities and
`LedgerService.post` refuses to post (§6) even if a service forgets.

## 3. Decisions (owner-approved on 2026-10-30)

| #   | Decision                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | Existing "done by" columns always hold the real human; additive `*_impersonation_id` columns link the impersonation (§11) |
| D2  | Every route that posts to the ledger, declares cash or gives financial consent is forbidden                               |
| D3  | Merchant pickup-zone request and withdrawal: forbidden (use `PUT /admin/merchants/:id/pickup-zone`)                       |
| D4  | Merchant payout cancellation: forbidden (use `POST /admin/finance/payouts/:id/cancel`)                                    |
| D5  | Merchant return request: safeguarded, with the fee consequence shown and acknowledged (§10)                               |
| D6  | Driver custody transitions: safeguarded, with a reason required for every action                                          |
| D7  | The target's own sessions stay active; at most one active impersonation per actor and per target (§9)                     |
| D8  | The target is emailed a safe summary when the impersonation ends (§13)                                                    |
| D9  | Step-up: password re-entry, valid 5 minutes, consumed by one start (TOTP later)                                           |
| D10 | Hand-off by `postMessage`, never a URL (§8)                                                                               |
| D11 | Ledger hard stop in the application plus invariant tests; no database trigger in 4C                                       |
| D12 | Nobody can record a delivery for a driver in 4C (accepted support gap)                                                    |
| D13 | The target's language preference is changed locally only, never written                                                   |
| D14 | Ending the admin session (logout or expiry) ends that admin's impersonations                                              |

Rules for starting: SUPER_ADMIN only, from a normal admin session (never from an impersonation
session: no nesting), verified email, step-up within 5 minutes, a mandatory reason and an optional
ticket reference. Refused for the actor themselves, for any staff role (including SUPER_ADMIN) and
for a target that is not ACTIVE. Duration: 30 minutes from the start, never extended.

## 4. Route classification

Every route is classified. During impersonation an unclassified route is denied, and a test that
walks every registered route fails the build if one is unclassified.

- **A — Allowed:** permitted; reads, or no financial effect.
- **S — Safeguarded:** permitted with the controls in §10 (consequence acknowledgement where
  listed), a reason where listed, both identities in audit and history, and the impersonation
  re-checked inside the write transaction.
- **F — Forbidden:** `403 IMPERSONATION_FORBIDDEN_ACTION`.

### 4.1 Routes a merchant or driver can reach

| Route (`/v1`)                                                                           | 4C               | Notes                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/me`                                                                          | A                | Adds the impersonation (actor name, `expiresAt`, `serverNow`)                                                                                                        |
| `POST /auth/logout`                                                                     | A (remapped)     | Ends the impersonation only; the target's real sessions are untouched                                                                                                |
| `POST /auth/resend-verification`                                                        | F                | Credential flow                                                                                                                                                      |
| `POST /auth/register`, `/login`, `/forgot-password`, `/reset-password`, `/verify-email` | Public           | Ignore the impersonation cookie; hidden in the impersonation UI                                                                                                      |
| `PATCH /me/preferences`                                                                 | F                | D13                                                                                                                                                                  |
| `GET /zones`, `GET /health`, `GET /health/ready`                                        | A / Public       | —                                                                                                                                                                    |
| `GET /merchant/shipments`, `GET /merchant/shipments/:id`                                | A                | —                                                                                                                                                                    |
| `POST /merchant/shipments`                                                              | S + ack          | §10 C1. Merchant input schema only (no manual fee)                                                                                                                   |
| `POST /merchant/shipments/:id/transitions` → `CANCELLED`                                | S                | §10 C2                                                                                                                                                               |
| … → `RETURN_REQUESTED`                                                                  | S + ack          | §10 C3                                                                                                                                                               |
| `GET /merchant/pickup-zone`                                                             | A                | —                                                                                                                                                                    |
| `POST /merchant/pricing/quote`                                                          | S                | Persists a single-use, short-lived quote only this merchant can use; posts nothing. Records the real actor and the impersonation (`pricing_quotes.impersonation_id`) |
| `PUT /merchant/pickup-zone`, `DELETE /merchant/pickup-zone/request`                     | F                | D3                                                                                                                                                                   |
| `GET /merchant/finance`, `GET /merchant/finance/shortfalls`                             | A                | —                                                                                                                                                                    |
| `POST /merchant/finance/payouts`                                                        | F                | Financial consent                                                                                                                                                    |
| `POST /merchant/finance/payouts/:id/cancel`                                             | F                | D4                                                                                                                                                                   |
| `POST /merchant/finance/shortfalls/:id/accept`, `…/decline`                             | F                | Financial consent                                                                                                                                                    |
| `GET /driver/shipments`, `GET /driver/shipments/:id`                                    | A                | —                                                                                                                                                                    |
| `POST /driver/shipments/:id/transitions` → `PICKED_UP`, `OUT_FOR_DELIVERY`, re-attempt  | S + reason       | §10 C5                                                                                                                                                               |
| … → `DELIVERY_FAILED`                                                                   | S + reason + ack | §10 C4                                                                                                                                                               |
| … → `RETURN_IN_TRANSIT`, `RETURNED_TO_HUB`                                              | S + reason + ack | §10 C6                                                                                                                                                               |
| … → `DELIVERED`                                                                         | F                | Posts COD and the delivery fee; attests cash custody                                                                                                                 |
| … → `RETURNED` (from `RETURN_IN_TRANSIT`)                                               | F                | `ReturnsService.onReturned` can post the return fee                                                                                                                  |
| `POST /driver/shipments/:id/collections`                                                | F                | COD posting and cash custody                                                                                                                                         |
| `GET /driver/finance`                                                                   | A                | —                                                                                                                                                                    |
| `POST /driver/finance/settlements`                                                      | F                | Cash declaration; the counter route already exists                                                                                                                   |

Transitions share one route, so the per-status classification lives in a policy table in
`@coobra/shared` and is enforced in the service.

### 4.2 Staff-only routes (72): all forbidden during impersonation

Users (7), audit logs (2), finance core (14), payouts (8), settlements, shortages and repayments
(10), reports (3), returns (3), zones and pricing (16), admin shipments (9). The target's role
already fails `@Roles`; the guard also denies them explicitly. Phase 4C.1 tests that each is
classified `FORBIDDEN` (`STAFF_ONLY`) and that its roles exclude MERCHANT and DRIVER; Phase 4C.3
adds the request-level test that each returns 403 during an impersonation.

### 4.3 New routes

| Route                                    | Session                                       |
| ---------------------------------------- | --------------------------------------------- |
| `POST /auth/reauthenticate`              | Normal admin session (SUPER_ADMIN)            |
| `POST /admin/impersonations`             | Normal admin session + step-up within 5 min   |
| `GET /admin/impersonations`, `GET …/:id` | Normal admin session (SUPER_ADMIN)            |
| `POST /admin/impersonations/:id/end`     | Normal admin session (SUPER_ADMIN)            |
| `POST /auth/impersonation/exchange`      | Exchange code + verifier, exact target origin |
| `POST /impersonation/end`                | The impersonation session (banner End button) |

## 5. Lifecycle

1. **Step-up:** `POST /auth/reauthenticate` checks the password (login rate limiter, failures
   audited) and sets `sessions.reauthenticated_at` on the admin session.
2. **Start** (§8 for the hand-off, §9 for concurrency): creates the `ImpersonationSession` and a
   single-use exchange code; consumes the step-up; audits `IMPERSONATION_STARTED`.
3. **Exchange:** creates a fresh session for the target, bound to the target's client app and to
   the impersonation, with `expiresAt` equal to the impersonation's. Never reuses or adopts an
   existing session.
4. **Every request:** the session must be unrevoked and unexpired; the impersonation must be
   active; the actor must be ACTIVE and SUPER_ADMIN; the actor's admin session must be valid; the
   target must be ACTIVE and still MERCHANT or DRIVER.
5. **End**, with the reason recorded: `MANUAL` (banner or admin console), `EXPIRED`,
   `ACTOR_LOGOUT`, `ACTOR_SESSION_ENDED`, `ACTOR_REVOKED` (actor deactivated or role changed, in
   the same transaction as that change) or `TARGET_REVOKED` (target deactivated). Ending revokes
   the session, writes `IMPERSONATION_ENDED` and queues the summary (§13) in one transaction.

## 6. Financial invariants

1. **No journal entry is created during impersonation.** Enforced by the route classification,
   the transition policy table and `LedgerService.post` throwing when the request context carries
   an impersonation. `journal_entries` gets no new column; existing entries are never touched.
2. **No financial consent, cash declaration or cash count during impersonation.** Accountant-only
   confirmation (`CASH_COUNT_ROLES = ['ACCOUNTANT']`) is unchanged and unreachable.
3. **Every permitted write records actor, effective account and impersonation** in the audit
   entry and in the operational history row, in the same transaction.
4. **Attribution is never rewritten.** All new columns are nullable; existing rows stay null; no
   backfill.
5. **No self-approval through impersonation** (§11.3 and rule R1).

## 7. Schema (migration 14, as built in Phase 4C.1)

Migration `20261030120000_impersonation_foundation` is additive: it creates three tables, adds
seven nullable columns to existing tables, and adds indexes, foreign keys and CHECK constraints. It
drops, renames or retypes nothing, and touches no ledger or money table (`journal_entries`,
`journal_lines` and every payout, settlement, shortfall and adjustment table are unchanged). The
Prisma models are in `packages/database/prisma/schema.prisma`.

**New tables**

| Table                          | Holds                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `impersonation_sessions`       | Actor, the admin session it started from, target and target role, client app, reason, ticket, start/expiry/end, end reason, request IP and user agent. Never deleted. |
| `impersonation_exchange_codes` | One single-use code per impersonation: SHA-256 hash, verifier challenge, expiry, use time                                                                             |
| `notification_outbox`          | Durable, idempotent email outbox (§13). References only; no message content                                                                                           |

**New nullable columns on existing tables** (NULL on every existing row; verified in §17)

| Table                     | Columns                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `sessions`                | `impersonation_id` (unique), `reauthenticated_at`                                             |
| `audit_logs`              | `effective_user_id`, `impersonation_id`                                                       |
| `shipment_status_history` | `impersonation_id`                                                                            |
| `shipments`               | `created_impersonation_id`                                                                    |
| `return_records`          | `requested_impersonation_id`                                                                  |
| `pricing_quotes`          | `impersonation_id`                                                                            |
| `financial_adjustments`   | `source_type` (NOT NULL, default `UNLINKED`), `source_shipment_id`, `source_journal_entry_id` |

**Rules the database enforces** (whatever code path writes the rows)

| Rule                                                                                                                                                                                                                                                                | Mechanism                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At most one active impersonation per actor and per target                                                                                                                                                                                                           | Unique `active_actor_id` / `active_target_id` + `impersonation_sessions_active_slots_check` (§9)                                                                                      |
| Targets are MERCHANT in the merchant app or DRIVER in the driver app                                                                                                                                                                                                | `impersonation_sessions_target_check`                                                                                                                                                 |
| Never yourself                                                                                                                                                                                                                                                      | `impersonation_sessions_not_self_check`                                                                                                                                               |
| 30 minutes at most, never extended                                                                                                                                                                                                                                  | `impersonation_sessions_duration_check` on insert; afterwards no column but the end can change (trigger below)                                                                        |
| End reason exactly when ended; a reason is required                                                                                                                                                                                                                 | `impersonation_sessions_end_check`, `impersonation_sessions_reason_check`                                                                                                             |
| The real actor and the target are the impersonation's own                                                                                                                                                                                                           | Composite foreign keys: actor **and** target on `audit_logs`, `shipments` and `pricing_quotes`; actor on `shipment_status_history` and `return_records`; target on `sessions` (§11.1) |
| An impersonated record always names its real actor                                                                                                                                                                                                                  | `*_impersonation_check` on the same tables (composite keys are not checked when a column is NULL)                                                                                     |
| A temporary session belongs to the target, outside the admin app, with no step-up                                                                                                                                                                                   | `sessions_impersonation_id_user_id_fkey`, `sessions_impersonation_check`                                                                                                              |
| Codes are hashes, challenges are base64url SHA-256, valid ≤ 60 s                                                                                                                                                                                                    | `impersonation_exchange_codes_format_check`, `impersonation_exchange_codes_ttl_check`, one code per impersonation                                                                     |
| One notification per event; consistent delivery state                                                                                                                                                                                                               | Unique `dedupe_key`, `notification_outbox_state_check`, `notification_outbox_kind_check`                                                                                              |
| The people are real: an active SUPER_ADMIN, from their own unrevoked admin session (never an impersonation session), and an active target whose real role is the recorded one                                                                                       | `impersonation_sessions_people_check` trigger on insert (reads `users` and `sessions`)                                                                                                |
| An impersonation is permanent: it is ended once, nothing else about it ever changes, and it is never deleted                                                                                                                                                        | `impersonation_sessions_immutable` trigger                                                                                                                                            |
| A code is only ever redeemed, once; never deleted                                                                                                                                                                                                                   | `impersonation_exchange_codes_immutable` trigger                                                                                                                                      |
| Attribution written during an impersonation is permanent: the impersonation column is set when the record is written and never changes (not set later, cleared or moved), the actor/target columns of such a record are frozen, and such a record cannot be deleted | `*_attribution_immutable` triggers on `audit_logs`, `shipment_status_history`, `shipments`, `return_records`, `pricing_quotes`, `sessions`                                            |
| Adjustment provenance is real for the merchant and never changes                                                                                                                                                                                                    | `financial_adjustments_source_check`, `financial_adjustments_provenance_check` and `financial_adjustments_provenance_immutable` triggers (§10.4)                                      |
| Nothing can be removed from the parent side                                                                                                                                                                                                                         | Every new foreign key is `ON DELETE RESTRICT ON UPDATE RESTRICT`                                                                                                                      |

Prisma does not model CHECK constraints or triggers and does not introspect them, so they cause
no drift (the ledger triggers of migration 4 work the same way). Every foreign key, including the
composite ones, is modelled in the Prisma schema. The triggers fire only when one of their
columns is written and do nothing for rows written outside impersonation, so existing behaviour
is unchanged; like the ledger triggers, they do not fire on `TRUNCATE`.

**Deployment (measured on 2.1M rows, 2026-10-30).** The migration is atomic: Prisma runs it as
one transaction, and a failure part-way leaves nothing behind (tested; recovery is
`prisma migrate resolve --rolled-back 20261030120000_impersonation_foundation` and a redeploy).
Until it commits it holds `ACCESS EXCLUSIVE` on `sessions`, `audit_logs`, `shipments`,
`shipment_status_history`, `return_records`, `pricing_quotes` and `financial_adjustments`, and
locks that block writes on `users` and `journal_entries` (new foreign keys point at them; no ledger
row or column changes). On 1M audit entries, 300k shipments and 600k history rows all 77
statements took 2.2 s, the largest being the two `audit_logs` indexes. The first statement,
`SET LOCAL lock_timeout = 5s`, makes it give up cleanly instead of queueing live traffic behind
a long-running transaction; it is then re-run when the database is quieter. Adding the
`source_type` column with a constant default is catalogue-only (no rewrite). Rollback:
`packages/database/prisma/rollback/20261030120000_impersonation_foundation.down.sql` restores
migration 13 exactly (tested: identical schema and data) and refuses to run once impersonations
or adjustment provenance exist; after go-live the fix is forward only.

## 8. Clarification 1 — cross-origin hand-off

### 8.1 Origins and sites

| Component     | Local development (`.env.example`) | Session storage today                                                        |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Admin console | `http://localhost:3000`            | Its own httpOnly cookie on the admin origin; the BFF sends Bearer to the API |
| Driver web    | `http://localhost:8081`            | httpOnly `coobra_session` on the API host                                    |
| Merchant web  | `http://localhost:8082`            | httpOnly `coobra_session` on the API host                                    |
| API           | `http://localhost:4000`            | Sets `coobra_session` (`SameSite=Strict`, host-only, `Path=/`)               |

`SameSite` compares **sites** (scheme + registrable domain; ports are ignored), so the apps and
the API are same-site in development and `SameSite=Strict` cookies are sent on their `fetch`
calls. `localhost` and `127.0.0.1` are different sites: development must use `localhost`
consistently.

**Production requirement (already implied by today's Expo web login, now written down):** the
API, the admin console and both web apps must share one registrable domain over HTTPS, for
example `api.`, `admin.`, `merchant.` and `driver.` under one domain. If the API were on another
site, `SameSite=Strict` cookies would not be sent and browsers that block third-party cookies
would drop them. A start-up check in production refuses to run if the configured app URLs and the
API URL are not same-site, or are not HTTPS.

### 8.2 Why a separate cookie

Both web apps use the same `coobra_session` cookie on the API host, so an impersonation that
reused it would overwrite any real session in that browser. Impersonation uses its own cookie:

| Attribute | Value                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| Name      | `__Host-coobra_imp_session` when `COOKIE_SECURE=true`; `coobra_imp_session` in development |
| Flags     | `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain` (host-only), `Secure` per config      |
| Lifetime  | `Max-Age` = seconds left until the impersonation's `expiresAt`                             |

The guard reads the impersonation cookie **only** when the request carries the
`x-coobra-impersonation: 1` header **and** its `Origin` equals the target app's configured URL
exactly. With the header present and no valid impersonation session the answer is 401: it never
falls back to `coobra_session`. Without the header the impersonation cookie is ignored. The app
tab keeps the "impersonating" flag in `sessionStorage`, which is per tab, so other tabs of the
same app keep using the real session.

### 8.3 Hand-off sequence

1. In the start dialog the SUPER_ADMIN enters the reason, optional ticket and password; the
   console calls step-up through the BFF.
2. On the Start click the console **synchronously** calls
   `window.open('<target app URL>/impersonate', 'coobra-impersonation')`, which avoids popup
   blockers. It does not pass `noopener`, because the hand-off needs `window.opener`.
3. The new tab generates a random verifier, keeps it in memory only, and posts
   `{ type: 'coobra:impersonation:ready', challenge }` to `window.opener` with `targetOrigin` set
   to the configured admin URL.
4. The console accepts the message only if `event.origin` equals the target app URL **and**
   `event.source` is the window it opened. It then calls `POST /admin/impersonations` through the
   BFF with the target, reason, ticket and the challenge.
5. The API returns a code: 32 random bytes, stored as a SHA-256 hash, valid 60 seconds, single
   use, bound to the impersonation, the client app and the challenge.
6. The console posts `{ type: 'coobra:impersonation:code', code }` to the opened window with
   `targetOrigin` set to the target app URL, then forgets the code.
7. The tab accepts it only if `event.origin` equals the admin URL **and**
   `event.source === window.opener`. It calls `POST /auth/impersonation/exchange` with the code
   and the verifier, sets `window.opener = null`, and from then on sends the impersonation header.
8. The API redeems the code with one conditional update
   (`SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`). It
   requires `Origin` to equal the target app URL, the verifier to match the challenge, and the
   impersonation and the actor's admin session to be active. It creates the session and sets the
   cookie with `Cache-Control: no-store`.

If no code arrives within 15 seconds the tab shows "Start again from the admin console", and the
unused code expires on its own.

### 8.4 Controls by threat

| Threat                       | Control                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token or code in a URL       | Never: the code travels by `postMessage`, the session only in an httpOnly cookie                                                                                                                                                                             |
| Code stolen from the console | Useless without the verifier, which exists only in the opened tab's memory                                                                                                                                                                                   |
| Replay                       | Single use (conditional update), 60 s lifetime, one code per impersonation                                                                                                                                                                                   |
| Wrong window receives code   | `targetOrigin` pinned on every `postMessage`; `event.origin` and `event.source` checked on both sides                                                                                                                                                        |
| Session fixation             | A new session is always created at exchange; separate cookie name                                                                                                                                                                                            |
| CSRF                         | `SameSite=Strict`; the custom header forces a CORS preflight; exact `Origin` match on every request carrying the impersonation cookie, including GETs. `SameSite` does not protect against sibling subdomains of the same site; the exact-origin check does. |
| Token leakage in logs        | Exchange request bodies are never logged; responses are `no-store`                                                                                                                                                                                           |
| Privilege escalation         | Effective role is the target's; staff targets refused; `/admin/*` denied; no nesting                                                                                                                                                                         |
| Concurrent or stale sessions | §9; per-request re-validation (§5); revocation on every end reason                                                                                                                                                                                           |
| Deactivation                 | Target: existing revocation covers the session. Actor: impersonations end in the same transaction as the change.                                                                                                                                             |

### 8.5 CORS and headers to keep

- The API's CORS (`apps/api/src/configure-app.ts`: `origin: corsOrigins`, `credentials: true`)
  stays. It lists `allowedHeaders` explicitly (`content-type`, `authorization`,
  `x-auth-transport`, `idempotency-key`), so Phase 4C.3 must add `x-coobra-impersonation`;
  until then a browser preflight refuses the header, which keeps impersonation off by
  construction. (Corrected in 4C.1: an earlier draft assumed the headers were reflected.)
- The admin console and both web apps must not send `Cross-Origin-Opener-Policy: same-origin`,
  which would cut `window.opener`. Use `same-origin-allow-popups` on the console if COOP is added.
  Neither sends COOP today (`apps/admin-web/next.config.ts`).
- Helmet's defaults on the API apply only to API responses and do not affect the hand-off.

### 8.6 Native (designed, not built)

Native apps will reuse the exchange endpoint with the same verifier binding, delivered through a
deep link (`coobra-merchant://`, `coobra-driver://`), Bearer transport and a separate SecureStore
key.

## 9. Clarification 2 — at most one active impersonation per actor and per target

**Row locking alone is not enough.** It protects only code paths that take the locks; a future
path, a script or a manual insert would bypass it. The guarantee is therefore enforced by the
database, with locking kept on top for predictable errors.

**Database guarantee.** `active_actor_id` and `active_target_id` are `UNIQUE` and nullable. The
`impersonation_sessions_active_slots_check` (§7) forces a row to hold both slots exactly while it
is not ended, and both to be NULL once it is. PostgreSQL allows any number of NULLs in a unique
column.

**Proof.** Suppose two rows r1 and r2 are both not ended at the same time for actor A. By the
CHECK, `r1.active_actor_id = A` and `r2.active_actor_id = A`, which violates the unique index. The
same argument applies to the target. PostgreSQL enforces uniqueness at insert and update time
across concurrent transactions at every isolation level: a second inserter waits for the first's
uncommitted index entry and fails if it commits. So no interleaving can commit two active rows for
one actor or one target. The argument does not depend on the application code.

**Start transaction (for clean errors):**

1. `SELECT … FROM users WHERE id IN (actor, target) ORDER BY id FOR UPDATE`. The fixed order
   prevents deadlocks between two starts.
2. Close any of the actor's or target's rows that are past `expires_at` but not ended
   (`EXPIRED`), releasing their slots.
3. If an active row still exists, return `409 IMPERSONATION_ACTIVE` (for the actor or the target).
4. Insert the new row. A unique violation that still happens (a path that skipped the locks) is
   mapped to the same 409.

**Related atomic steps.**

- Ending is one conditional update
  (`SET ended_at = now(), active_actor_id = NULL, active_target_id = NULL, ended_reason = $r WHERE id = $1 AND ended_at IS NULL`),
  so exactly one ender wins and only the winner revokes, audits and queues the summary.
- One temporary session per impersonation (`sessions.impersonation_id` is unique, and its
  composite key makes the session's user the impersonation's target); one code per impersonation.
- Actor and target sets cannot overlap: targets are MERCHANT or DRIVER (CHECK), actors are
  SUPER_ADMIN, and 4A forbids role changes for drivers and merchants.
- An expired row that nobody touches is closed by the expiry sweeper (§13), so slots do not stay
  held, and the request path already rejects it once `expires_at` has passed.

**Tests.** Phase 4C.1 proves the database guarantee in
`apps/api/test/impersonation-schema.integration-spec.ts`: a second active row for the same actor
or the same target fails; two concurrent transactions starting the same target commit exactly
one; a raw insert that bypasses the application fails; ending twice updates once; ended rows
release the slots. Phase 4C.3 adds the service-level tests: end racing an in-flight write, and
expiry at the boundary.

## 10. Clarification 3 — allowed operations with delayed financial consequences

Found by tracing `ShipmentsService.create` and `transition`, `ReturnsService.ensureRecord`,
`deliveryCharge` and `onReturned`, and `CodService.onDelivered`.

| #   | Allowed operation                                                 | Delayed consequence                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Merchant creates a shipment                                       | Fixes the immutable pricing snapshot (`shipment_pricing`: delivery fee, return fee, return policy, attempt fee). The delivery fee is charged to the merchant at `DELIVERED`. The COD amount becomes what the driver must collect and the merchant is credited; a wrong amount leads to the recipient-shortfall process. |
| C2  | Merchant cancels (`CREATED → CANCELLED`)                          | None: no cancellation fee exists and nothing is posted. Irreversible.                                                                                                                                                                                                                                                   |
| C3  | Merchant requests a return (`DELIVERY_FAILED → RETURN_REQUESTED`) | Creates the return record. If the pricing rule has a return fee, `feeStatus` is `SET` and the fee **plus the delivery charge** is posted automatically when the shipment reaches `RETURNED`, with no further decision. Otherwise finance must decide the fee.                                                           |
| C4  | Driver records a failed delivery (`→ DELIVERY_FAILED`)            | The first failed attempt makes the delivery charge payable on a later return under `DELIVERY_PLUS_RETURN` (full delivery fee) or the attempt-fee policy (attempt fee, capped at the delivery fee). It also makes a merchant return request possible.                                                                    |
| C5  | Driver `PICKED_UP`, `OUT_FOR_DELIVERY`, re-attempt                | No charge. `PICKED_UP` removes the merchant's ability to cancel; `OUT_FOR_DELIVERY` counts an attempt, which no fee uses today.                                                                                                                                                                                         |
| C6  | Driver `RETURN_IN_TRANSIT`, `RETURNED_TO_HUB`                     | Moves the return towards `RETURNED`, where the return fee and delivery charge are posted: by staff closing it, or by the real driver's own `RETURN_IN_TRANSIT → RETURNED` (forbidden during impersonation).                                                                                                             |

### 10.1 Controls for every safeguarded write

1. **Server-generated confirmation (R2, §10.3)** for C1, C3, C4 and C6.
2. **Bilingual confirmation dialog:** "You are acting as {name}. This will …", with each amount
   labelled by its certainty.
3. **Reason:** required for C2–C6 (already required for C2, C3 and C4 by the transition rules).
4. **Audit:** the existing action (for example `SHIPMENT_CREATED`) carries both identities and
   the impersonation (§11.1), plus an `impersonation` metadata block with the reason, the
   confirmed consequence lines and the token fingerprint, in the same transaction.
5. **No posting:** nothing is posted during the impersonation (§6). Every later posting step on a
   shipment an impersonation touched is a separate, non-impersonated action by a human who was
   not involved (R1, §10.2).

### 10.2 Rule R1 — impersonation conflict of interest (refined)

If a SUPER_ADMIN performed **any** impersonated action on a shipment, that SUPER_ADMIN may never
take the decisions below on that shipment. Another authorised staff member must. The restriction
**persists after the impersonation ends or expires**, for the life of the shipment.

**Involvement** is read from durable records only. All of them are append-only or never updated,
reference the impersonation with `ON DELETE RESTRICT`, and are checked by composite keys (§11.1):

| Source                                                         | Involvement                                    |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `shipments.created_impersonation_id`                           | Created the shipment as the merchant           |
| `shipment_status_history.impersonation_id`                     | Any status change as the merchant or driver    |
| `return_records.requested_impersonation_id`                    | Requested the return as the merchant           |
| `audit_logs.impersonation_id` with the shipment id in metadata | Any other impersonated action on it (backstop) |

The `*_attribution_immutable` triggers make these markers permanent in the database: they are
written with the record and can never be cleared, moved or deleted (§7). Each joins
`impersonation_sessions.actor_user_id`. Whether the impersonation is active, ended or
expired does not matter.

**Guarded decisions.** Each checks the **real actor** (`ctx.actor.id`) inside the decision's own
transaction, after the shipment row is locked:

- approving a return (`POST /v1/admin/shipments/:id/return/approve`);
- closing a return at `RETURNED` (`POST /v1/admin/shipments/:id/transitions` from
  `RETURN_REQUESTED`, `RETURN_APPROVED` or `RETURNED_TO_HUB`), which posts the return charges;
- setting or waiving the return fee (`POST /v1/admin/returns/:shipmentId/fee`, `…/waive`);
- overriding the fee (`POST /v1/admin/shipments/:id/fee-override`);
- requesting, approving or rejecting a fee correction for the shipment;
- proposing, approving or rejecting a recipient shortfall for the shipment.

Error: `403 IMPERSONATION_CONFLICT`. A shipment with no impersonated involvement behaves exactly
as today, and so does any staff member who was not involved.

Financial adjustments, which correct posted amounts, have their own transaction-level conflict
of-interest model in §10.4.

### 10.3 Rule R2 — server-generated, tamper-resistant confirmation (refined)

**Token.** `v1.<key id>.<payload>.<mac>`: the payload is canonical JSON (sorted keys, base64url)
and the MAC is HMAC-SHA256 under a dedicated secret (`CONSEQUENCE_SIGNING_KEY`, at least 32
random bytes, added in Phase 4C.4; the key id allows rotation). The payload binds:

- the impersonation, the real actor and the target;
- the action (`CREATE_SHIPMENT`, or the transition `from → to`);
- the shipment, its `version` and `status` (for a creation: a fingerprint of the input, that is
  the merchant, the zones, the COD amount and the quote);
- the pricing fingerprint: rule id and version, final fee, return fee, return policy and attempt
  fee (from `shipment_pricing`, or from the quote for a creation);
- the return state where one exists: fee status, fee amount, delivery charge and the number of
  failed attempts;
- the consequence lines (below), the issue time and `expiresAt` (at most 5 minutes).

**Verification**, inside the write transaction after the shipment row is locked:

1. Constant-time MAC check with a known key id; not expired.
2. The impersonation, actor and target match the request.
3. The preview is **recomputed from the locked state** and must equal the signed payload.

A missing token is refused with `400 CONSEQUENCE_CONFIRMATION_REQUIRED` and any difference with
`409 CONSEQUENCE_CHANGED`; the UI then shows the new preview. A confirmation therefore goes stale
when the pricing rule is revised, the fee is overridden or corrected, the return fee is set or
waived, the shipment changes status or version, the failed-attempt count or the policy changes,
the token expires or the impersonation ends. It cannot be replayed: the shipment version changes
with the write, and the token names one impersonation.

**Guaranteed versus estimated.** Every line has a certainty and the UI labels it. Amounts of
different certainty are never added into one total.

| Certainty   | Meaning                                                                                                                                                                                            | UI label                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `FIXED`     | The amount on record now; no automatic recalculation changes it, but an authorised, audited staff decision still can before it is posted (fee override or correction, return-fee change or waiver) | "Charged if …, unless staff adjust it" |
| `ESTIMATED` | Can still change before the trigger                                                                                                                                                                | "Estimate"                             |
| `UNDECIDED` | Finance decides later; no amount                                                                                                                                                                   | "To be decided by finance"             |

| Action | Line                     | Certainty                                                                                              | Trigger             |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------- |
| C1     | `DELIVERY_FEE`           | FIXED (pricing snapshot)                                                                               | On delivery         |
| C1     | `COD_TO_COLLECT`         | FIXED                                                                                                  | On delivery         |
| C1     | `RETURN_FEE`             | FIXED if the rule has a return fee, otherwise UNDECIDED                                                | On return completed |
| C1     | `RETURN_DELIVERY_CHARGE` | ESTIMATED, shown as "up to": only if a delivery fails and the shipment is returned                     | On return completed |
| C3, C6 | `RETURN_FEE`             | FIXED when `SET` (posted automatically on `RETURNED`), UNDECIDED when unconfigured                     | On return completed |
| C3, C6 | `RETURN_DELIVERY_CHARGE` | FIXED (stored on the return record when it is created)                                                 | On return completed |
| C4     | `RETURN_DELIVERY_CHARGE` | FIXED by the snapshot policy, charged only if the shipment is later returned; none under `RETURN_ONLY` | On return completed |

**What the confirmation guarantees.** It proves the person saw these exact amounts at the moment
of the write. It does not freeze them: later staff decisions can still change a fee, and those
decisions are audited and subject to R1. `COD_TO_COLLECT` is the only line no route changes
before delivery.

**Never a posting.** A confirmation authorises the operational write only. Nothing is posted
during the impersonation (§6). The amounts are posted later by non-impersonated actions (the real
driver's delivery, the real driver or staff closing the return), and those are subject to R1.

The contracts (`ConsequenceLine`, `ConsequencePreview`, `consequenceConfirmationSchema`, and the
certainty and trigger lists) are in `packages/shared/src/impersonation.ts`.

### 10.4 Financial adjustments: transaction-level conflict of interest (owner-approved 2026-10-30)

A posted fee is corrected through a financial adjustment. Adjustments therefore record **what they
correct** (provenance), and the approval checks the approver against the people involved in that
exact transaction. This applies with or without impersonation. There is no merchant-wide ban.

**Provenance** (migration 14, `financial_adjustments`):

| `source_type`   | Names                                                          | Typical use                                                                                                              |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SHIPMENT_FEE`  | The shipment (required) and its posting (optional)             | Correcting a posted delivery fee                                                                                         |
| `RETURN_CHARGE` | The shipment (required) and its posting (optional)             | Correcting a posted return fee or delivery charge                                                                        |
| `COD_SHORTFALL` | The shipment (required) and its posting (optional)             | Correcting a shortfall resolution                                                                                        |
| `JOURNAL_ENTRY` | The posting (required); a shipment only if the posting has one | Any posting on the merchant's account **without a shipment**: payouts, merchant payments, earlier adjustments, reversals |
| `UNLINKED`      | Nothing                                                        | No verifiable provenance; every adjustment written before migration 14                                                   |

Database rules: `financial_adjustments_source_check` (each type names what it needs); the
`financial_adjustments_provenance_check` trigger when an adjustment is requested (the shipment is
this merchant's; the posting moves one of this merchant's own accounts; a posting named with a
shipment has a line for that shipment); `financial_adjustments_provenance_immutable` (source,
merchant, requester, type and amount never change after the request; only the decision is
recorded later). Foreign keys to `shipments` and `journal_entries` are `RESTRICT`.

**Postings without a shipment.** `journal_lines.shipment_id` is optional, and postings such as
payouts, merchant payments, treasury transfers and adjustments have none. They are linked as
`JOURNAL_ENTRY`; the check then relies on the posting moving this merchant's accounts and on the
people behind that posting (below). A posting that moves none of the merchant's accounts cannot
be linked, so it falls back to `UNLINKED`, which fails closed.

**Approval check (Phase 4C.4).** It runs for approve **and** reject, inside the decision's own
transaction, after the adjustment row is locked (`FOR UPDATE`), using the **real actor**
(`ctx.actor.id`). The existing maker-checker rules (finance role, never the requester, the
approval threshold) run first and are unchanged. Then:

1. **Linked to a shipment:** refused (`403 IMPERSONATION_CONFLICT`) when the approver was involved
   in that shipment: any impersonated action on it (the R1 sources, §10.2), or a decision being
   corrected: who set or approved its return fee and return (`return_records.fee_set_by_id`,
   `approved_by_id`), who proposed or approved a fee override or correction
   (`shipment_fee_overrides.actor_id`, `approved_by_id`), who proposed or decided its shortfall,
   and who created any posting with a line for it.
2. **Linked to a posting:** refused when the approver created that posting
   (`journal_entries.created_by_id`), took a decision on the business record behind it (resolved
   from the posting's `source_type`/`source_id`: a payout's creator, approver or payer; a merchant
   payment's or transfer's recorder; an earlier adjustment's requester or decider), or appears as
   the actor of an impersonated audit entry about that record.
3. **`UNLINKED`, or provenance that cannot be resolved at decision time (fail closed):** the
   approver must be an independent reviewer: a finance user who is not the requester and **has
   never impersonated this merchant** (`impersonation_sessions`).

Mutable sources (`return_records`, `shipment_fee_overrides`) are read `FOR SHARE` inside the same
transaction; append-only and trigger-protected sources (postings, history, audit, impersonated
records) need no lock. The requester may be involved: they are the maker; the control is the
independent checker.

**When no eligible reviewer exists.** The adjustment stays `PENDING_APPROVAL` and the console says
that no eligible reviewer exists. There is no bypass, no override flag and no self-approval. The
future controlled escalation, to be designed and approved before it is built, is: (1) the owner
designates an additional finance reviewer through the audited 4A user-management flow (for
example a new ACCOUNTANT account); (2) that person, who by construction has no involvement,
decides; (3) alternatively the requester rejects the request and files it again with verified
provenance. Every step is audited; none lets an involved person decide.

**Tests (Phase 4C.4).** Each involvement source refuses the involved approver, for approve and
reject, also after the impersonation ended; an uninvolved finance user can decide; `UNLINKED`
refuses an approver who ever impersonated the merchant; unresolvable provenance fails closed;
the existing self-approval and threshold tests still pass. Phase 4C.1 already tests the database
rules (source check, provenance trigger including a posting without a shipment, immutability).

## 11. Clarification 4 — attribution contract

### 11.1 Audit log (`audit_logs`)

| Column              | Outside impersonation | During impersonation                                        |
| ------------------- | --------------------- | ----------------------------------------------------------- |
| `actor_user_id`     | The human who acted   | **The SUPER_ADMIN.** Never the target.                      |
| `target_user_id`    | The subject, as today | The subject, as today (for example the shipment's merchant) |
| `effective_user_id` | NULL                  | The impersonated account                                    |
| `impersonation_id`  | NULL                  | The impersonation session                                   |

Enforced by the database (migration 14, tested in 4C.1):

- `audit_logs_impersonation_check`: `effective_user_id` and `impersonation_id` are set together,
  and an impersonated entry always has an `actor_user_id`;
- composite key `(impersonation_id, actor_user_id)` → `impersonation_sessions(id, actor_user_id)`;
- composite key `(impersonation_id, effective_user_id)` → `impersonation_sessions(id, target_user_id)`.

So an entry can never name the wrong actor or the wrong account for its impersonation. A
composite key is not checked when one of its columns is NULL (`MATCH SIMPLE`), which is why the
CHECK makes the actor mandatory. Rows written outside impersonation are unaffected. The same
pattern protects `shipment_status_history`, `shipments`, `return_records` and `sessions` (§7).

`IMPERSONATION_STARTED`, `IMPERSONATION_ENDED` and the step-up events are actions of the admin:
actor = SUPER_ADMIN, target = the impersonated user, `effective_user_id` and `impersonation_id`
NULL. They name the impersonation in metadata as `impersonationId`, which the audit viewer
resolves as an `IMPERSONATION` entity.

### 11.2 Operational records written during impersonation

| Record                    | Column                                             | Holds                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipments`               | `merchant_id`                                      | The effective merchant (accountable party)                                                                                                                                                          |
|                           | `created_by_id`, `creator_role`                    | The real human and their role (SUPER_ADMIN). Same meaning as today's staff-created shipments, so existing screens already show "Created by {name} ({role})"                                         |
|                           | `created_impersonation_id`                         | The impersonation                                                                                                                                                                                   |
| `pricing_quotes`          | `created_by_id`, `merchant_id`, `impersonation_id` | The real human, the impersonated merchant and the impersonation (both tied by composite keys)                                                                                                       |
| `shipment_pricing`        | `priced_by_id`                                     | The real human (the rules price the shipment)                                                                                                                                                       |
| `shipment_status_history` | `actor_user_id`, `actor_role`                      | The real human and their role (the schema comment already says "never an impersonated identity")                                                                                                    |
|                           | `impersonation_id`                                 | The impersonation (the effective account and role come from it)                                                                                                                                     |
| `shipments`               | `driver_id`                                        | Unchanged: the accountable driver                                                                                                                                                                   |
| `return_records`          | `requested_by_id`                                  | The real human                                                                                                                                                                                      |
|                           | `requested_impersonation_id`                       | The impersonation                                                                                                                                                                                   |
| `sessions`                | `user_id`                                          | **The target.** The one place where the user column is the effective account: the session authenticates as the target, so the target's deactivation revokes it. `impersonation_id` links the actor. |
| `idempotency_records`     | —                                                  | Not used by any allowed route. If one is added later: `user_id` = the real human and the scope is prefixed `imp:<id>:`                                                                              |

Never written during impersonation, because every route that writes them is forbidden:
`journal_entries.created_by_id`, `shipments.delivered_by_id`, payout `created/approved/paid/cancelled_by_id`,
settlement `submitted_by_id`/`decided_by_id`, shortage `proposed/decided_by_id`, repayment and
payment `recorded_by_id`, adjustment `requested/decided_by_id`, shortfall `proposed/decided_by_id`,
return `approved_by_id`/`fee_set_by_id`, pickup-zone `decided_by_id`, finance setting
`updated/changed_by_id`. A Phase 4C.4 test asserts none of them is set inside an impersonation.

### 11.3 Maker-checker contract

- Every separation-of-duties comparison uses the **real human** on both sides: the stored "done
  by" column (always a real human under D1) against `ctx.actor.id`, never `ctx.principal.id`. The
  existing checks keep working unchanged: `ApprovalService.assertCanApprove`
  (`approver.id === proposerId`), payout approval (`payout.createdById === actor.id`) and
  settlement decisions (`settlement.driverId === actor.id || settlement.submittedById === actor.id`).
  Phase 4C.2 moves them to `ActingContext` and adds a test for each.
- Data scoping and business rules use `ctx.principal`: shipment and finance visibility, the
  transition actor (`shipmentActorForRole`), merchant and driver ownership checks.
- Rule R1 (§10) covers chains where the maker is the impersonated account but the real human is
  the later checker.
- Only MERCHANT and DRIVER can be impersonated, so no staff role, and with it no approval
  authority, is ever reachable through impersonation.

### 11.4 Display contract

Every admin screen that shows an actor shows "{actor} (Super admin) acting as {target}" when an
impersonation id is present. Merchant and driver screens keep today's rule (`creatorRole !==
'MERCHANT'` shows the creator), so a shipment created during impersonation shows the SUPER_ADMIN
as creator. The audit viewer gets an impersonation filter and both identities in the list and the
detail dialog.

## 12. New rules (owner-approved on 2026-10-30)

None changes behaviour outside impersonation.

| #   | Rule                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Impersonation conflict of interest (§10.2): the involved SUPER_ADMIN can never later approve, close, price or correct that shipment |
| R2  | Server-generated, tamper-resistant confirmation of financial consequences for C1, C3, C4 and C6 (§10.3)                             |
| R3  | A reason for every impersonated driver transition (D6)                                                                              |
| R4  | Production refuses to start unless the API and the web apps are same-site over HTTPS (§8.1)                                         |

## 13. End-of-impersonation notification (durable outbox)

**Ending never depends on email.** The end transaction (§5) revokes the session, writes
`IMPERSONATION_ENDED` and inserts one `notification_outbox` row
(`dedupe_key = impersonation-summary:<impersonation id>`,
`INSERT … ON CONFLICT (dedupe_key) DO NOTHING`). It commits whether or not mail works; an SMTP
outage only delays the email.

**Delivery (Phase 4C.3).** No scheduler exists in the API today, so 4C adds a sender: a Nest
provider on a 60-second interval, with no new dependency. It also closes impersonations that
expired without a request (`EXPIRED`), which enqueues their summaries.

1. **Claim:** select due rows (`status = 'PENDING' AND next_attempt_at <= now()`, lease absent or
   expired) `FOR UPDATE SKIP LOCKED`, then set a new random `lease_token`, `lease_expires_at`
   (2 minutes) and `attempts + 1`. Several API instances never claim the same row.
2. **Render** from the impersonation and its audit entries at send time; the outbox stores no
   message content.
3. **Send** with a stable `Message-ID: <notification-<outbox id>@coobra>`, so a resend after a
   crash is recognisable as the same message.
4. **Complete** with `UPDATE … SET status = 'SENT', sent_at = now(), lease cleared WHERE id = $1
AND lease_token = $2`. The lease token fences out a sender whose lease expired, so a row
   becomes SENT exactly once.
5. **Fail:** keep `PENDING` with exponential backoff (1, 2, 4, 8 minutes); after 5 attempts set
   `FAILED` and show it in the admin console. `last_error` holds a short, sanitised reason, never
   message content.

Delivery is at least once with idempotent completion. A crash between the SMTP acceptance and
step 4 can resend the same message with the same Message-ID. The database guarantees one row per
event (unique `dedupe_key`) and a consistent state; the single `SENT` transition comes from the
application's fenced conditional update (step 4)
(`notification_outbox_state_check`).

**Content (safe allowlist), in the target's language with RTL or LTR:** the start and end times,
the end reason, "a COOBRA administrator" with the admin's display name (consistent with today's
"Created by {name}" on shipments), and the actions taken, built from the audit entries of that
impersonation (action label, time, tracking number).

**Never included:** the support reason, the ticket reference, IP addresses, user agents, tokens,
codes or any link that signs the user in, other people's data, and amounts beyond what the
target's own app already shows.

## 14. Trade-offs

- **Operational, not financial.** Support cannot post COD, deliver, settle or accept on someone's
  behalf. Those stay with the account owner or the existing staff routes, at the cost of D12.
- **D1 keeps existing meaning** (the real human in "done by" columns) rather than adding parallel
  `*_actor_id` columns. The existing maker-checker checks therefore stay correct without rewrites,
  at the cost of the merchant seeing the SUPER_ADMIN as the creator of shipments made for them.
- **Database-enforced integrity** adds 16 CHECK constraints and 11 triggers that Prisma does not
  model, in
  exchange for guarantees that hold for any code path.
- **`postMessage` hand-off** needs `window.opener` and is web-only; native follows the same
  verifier design later.
- **Server-generated confirmation** adds one preview request before each safeguarded write and
  a new secret to manage.
- **At-least-once email**: a crash at the wrong moment can send a summary twice (same
  Message-ID); it is never lost and never blocks ending.

## 15. Unresolved risks

1. ~~Prisma drift from the raw CHECK constraints and composite keys~~: **resolved in 4C.1**; no
   drift on an upgraded or a fresh database (§17).
2. The production hosting of the Expo web apps is not defined in the repository; its headers
   (COOP) and the same-site deployment must be confirmed before release (R4 enforces the URLs).
3. The `ActingContext` refactor touches every merchant and driver service. Phase 4C.2 is a no-op
   refactor gated on the full existing suite passing unchanged.
4. A SUPER_ADMIN with XSS on the admin console could start impersonations; this is no worse than
   that admin's own access, and step-up limits it to the 5-minute window after re-entering a
   password.
5. D12 remains a support gap until a separate maker-checker design for deliveries recorded on a
   driver's behalf.
6. Applying migration 14 to the development database is the owner's step. Until it is applied,
   a regenerated Prisma client selects the new columns and fails against that database, so the
   running development API must not be restarted with a regenerated client before the migration.
7. ~~Deploying migration 14 to large tables~~: decided; `lock_timeout` added and the window measured (§7).
8. ~~Financial adjustments under R1~~: decided; transaction-level provenance model (§10.4).
9. The pre-existing admin-web test `applies search, area, event, record and date filters through
the URL` runs close to Vitest's 5-second limit under a fully parallel run and also fails on
   `main` that way; it is outside this phase.

## 16. Phases

| Phase | Delivers                                                                                  | Checkpoint                                                                   |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 4C.0  | This ADR and the revised `docs/impersonation.md`                                          | Done; owner approved on 2026-10-30                                           |
| 4C.1  | Migration 14, shared contracts, route classification, route-coverage and schema tests     | Done; approved at `1b7c0ab`; applied to the local development database (§17) |
| 4C.2  | `ActingContext` and request context everywhere; impersonation not yet possible            | **Done; awaiting owner review** (§18)                                        |
| 4C.3  | Step-up, start, hand-off, exchange, end, outbox sender, revocation; every write forbidden | Security, concurrency, session and outbox tests                              |
| 4C.4  | Safeguarded writes in groups with R1–R3, the confirmation token and the ledger hard stop  | Conflict-of-interest and financial-invariant tests                           |
| 4C.5  | Admin console screens, hand-off, banner and countdown, notification email                 | UI tests in Arabic and English                                               |
| 4C.6  | End-to-end journeys, security review, README and docs, pull request                       | Owner reviews the PR                                                         |

## 17. Phase 4C.1 validation record (2026-10-30)

Everything ran in a detached git worktree with its own dependencies and its own generated Prisma
client, against a throwaway PostgreSQL 16 container on port 55432. The development database and
the running development servers were not touched (the development database still has 13
migrations).

| Check                                      | Result                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline before any change                 | The existing integration suite passed on 13 migrations (13 files, 109 tests)                                                                                                                                                                                             |
| Upgrade with data                          | 1,616 seeded rows in 31 tables on 13 migrations; migration 14 applied by Prisma (no warnings, so `SET LOCAL lock_timeout` runs inside its transaction); checksums of all 31 existing tables identical; every new column NULL; every existing adjustment reads `UNLINKED` |
| Prisma drift                               | `prisma migrate diff --from-config-datasource --to-schema --exit-code`: no difference, on the upgraded and on a fresh database                                                                                                                                           |
| Constraints present                        | 16 new CHECK constraints, 9 composite foreign keys, the unique slot indexes and 11 guard triggers                                                                                                                                                                        |
| Locking and atomicity                      | Exact locks listed in §7; 2.2 s for all statements on 2.1M rows; a failure part-way leaves nothing behind                                                                                                                                                                |
| Rollback                                   | The rollback script restores a schema identical to migration 13 (pg_dump compared) and keeps every row (checksums identical); Prisma then re-applies migration 14 with no drift                                                                                          |
| Schema integration tests                   | `impersonation-schema.integration-spec.ts`: 46 tests (attribution, slots, people check, immutability, outbox, exchange codes, adjustment provenance including a posting without a shipment)                                                                              |
| Full suites (before the provenance change) | Integration 149/149 (14 files); unit tests in all packages; typecheck 12/12; lint clean                                                                                                                                                                                  |
| Route coverage                             | `route-classification.spec.ts`: 104 routes, all classified, none stale; 72 staff-only, 32 reachable by a merchant or driver                                                                                                                                              |
| Independent review                         | 4 reviewers and 4 adversarial verifiers; 20 findings (12 confirmed, 7 plausible, 1 refuted), all confirmed and plausible ones fixed or decided by the owner. Separately, the schema tests caught that a CHECK passes on NULL; fixed with `IS NOT DISTINCT FROM`          |

## 18. Phase 4C.2 record (2026-10-30)

**Delivered.** `apps/api/src/common/acting-context.ts` defines `ActingContext` (`actor`,
`principal`, `impersonation`). The global `AuthGuard` sets `request.auth.acting` on every
authenticated request, and a global interceptor runs the handler inside an `AsyncLocalStorage`,
so lower layers can read it. Impersonation stays disabled: `SessionService.authenticate` refuses
any session that belongs to an impersonation, so `impersonation` is always null and the actor
always equals the principal.

**Refactored (the paths an impersonation will reach).** Merchant and driver shipments (list,
get, create, transitions) and the merchant price quote take the acting context: role rules and
data scoping use the principal; `createdById`, `creatorRole`, `pricedById`, history actors,
`deliveredById`, the quote's `createdById` and posting authors use the actor. COD separates the
accountable driver (the principal, whose custody account receives the cash) from the person
recorded as acting (the actor). The staff shipment routes pass the same context and behave as
before.

**Enforced below the services.** `LedgerService.post` refuses (`IMPERSONATION_FORBIDDEN_ACTION`)
whenever the current request is impersonating, before touching the database. `AuditService` adds
the effective account and the impersonation to entries written during an impersonation, and
writes ordinary entries exactly as before (the new fields are omitted, not set to NULL).

**Unchanged by design.** Staff-only routes and the merchant/driver routes classified `FORBIDDEN`
(payouts, shortfall responses, settlements, collections, pickup-zone changes) keep `auth.user`:
they are never reachable during an impersonation, and outside one `auth.user` is both the actor
and the principal. Every maker-checker check (`ApprovalService`, payouts, settlements) compares
the stored real person with the real actor, as before. Merchant and driver finance reads scope by
the session's account, which is the principal.

**Validation.** Development database: backed up (verified by a full restore), migration 14
applied with identical data checksums, no drift, API healthy. Regression on the isolated
database: typecheck 12/12; unit tests 208/208 (47 in the API, including 9 for the acting
context, the ledger stop, audit stamping and the session refusal); integration 160/160 (including
`acting-context.integration-spec.ts`: unchanged attribution for merchant, staff and driver
writes, COD postings and quotes, scoping, and refusal of an impersonation session).
