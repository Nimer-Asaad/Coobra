# SUPER_ADMIN impersonation (Phase 4C — foundation in place, not enabled yet)

The decisions, threat model, schema and rationale are in
[ADR 0003](adr/0003-phase4c-impersonation.md). This page is the short reference.

## What it is

A SUPER_ADMIN can temporarily operate a **MERCHANT or DRIVER** account to give support, and the
app behaves like that account. It gives **full operational access, but no financial authority**:
an impersonated request never posts to the ledger, declares or counts cash, gives financial
consent or changes pricing configuration.

## Rules

- SUPER_ADMIN only, started from a normal admin session (no nesting), after re-entering the
  password within the last 5 minutes. A reason is required; a ticket reference is optional.
- Refused for yourself, for any staff account (including another SUPER_ADMIN) and for an account
  that is not active.
- 30 minutes from the start, never extended. At most one active impersonation per admin and per
  account, enforced by the database.
- Ends on the banner's End button, from the admin console, on expiry, when the admin logs out or
  their admin session ends, when the admin is deactivated or changes role, or when the account is
  deactivated. The account holder is emailed a short summary of what was done.

## Identities

Every request during impersonation carries four separate identities:

| Identity              | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| Real actor            | The SUPER_ADMIN. Recorded in every "done by" column and audit entry.  |
| Effective account     | The merchant or driver. Decides permissions and what data is visible. |
| Impersonation session | Recorded on every audit entry and history row written meanwhile.      |
| Accountable party     | The ledger account owner, always taken from the record itself.        |

The real actor and the effective account are never confused: maker-checker checks always compare
real humans (ADR 0003 §11).

## What can be done while impersonating

| Area                 | Allowed                                                                                                                                      | Forbidden                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Merchant shipments   | View; create (fee shown and confirmed); cancel; request a return (fee shown and confirmed)                                                   | —                                                                              |
| Driver shipments     | View; picked up, out for delivery, failed delivery, re-attempt, return in transit, returned to hub (reason required; fee consequences shown) | Delivered (COD), returned to the merchant, COD collection                      |
| Merchant finance     | View balances, payouts and shortfalls; price quotes                                                                                          | Request or cancel a payout; accept or decline a shortfall; pickup-zone changes |
| Driver finance       | View custody and settlements                                                                                                                 | Submit a settlement                                                            |
| Account and security | View the profile                                                                                                                             | Password, email, verification, preferences, sessions                           |
| Admin console        | —                                                                                                                                            | Every staff route                                                              |

Anything not explicitly classified is forbidden (`403 IMPERSONATION_FORBIDDEN_ACTION`).

A SUPER_ADMIN who acted on a shipment while impersonating cannot later approve, close, price or
correct that shipment as staff (`403 IMPERSONATION_CONFLICT`); another staff member must
(ADR 0003 §10, rule R1).

## How the hand-off works

The admin console opens the merchant or driver web app in a new tab. The two tabs exchange a
short-lived, single-use code by `postMessage`, with both origins checked. The app redeems the code
together with a secret only it holds, and the API sets a separate httpOnly impersonation cookie.
No token or code ever appears in a URL. Native apps will use the same exchange later through a
deep link (ADR 0003 §8).

## UI

- A persistent, high-contrast banner in Arabic and English: "You are acting as {name}", a
  countdown to expiry and an End button.
- A confirmation dialog, with any fee consequence, before each permitted change.
- Forbidden actions are hidden or disabled, with a pointer to the admin route that covers them.

## Status

Phase 4C.0 (design) is approved. Phase 4C.1 adds the database schema (migration
`20261030120000_impersonation_foundation`), the shared contracts and the classification of every
API route, with tests; it is awaiting owner review. Impersonation cannot be started yet: there
is no route, guard or UI for it. The remaining phases are listed in ADR 0003 §16.
