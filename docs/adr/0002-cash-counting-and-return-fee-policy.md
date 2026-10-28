# ADR 0002 — Accountant-controlled cash counting and configurable return-fee policy

- Status: accepted (2026-10-28), owner-approved decisions 1–2 of the post-Phase-3 review
- Scope: extends ADR 0001 sections on driver settlements and returns. Nothing else changes.

## 1. Driver cash hand-over: the accountant counts

| Action                                           | Who                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Declare own hand-over (driver app)               | DRIVER (own cash only)                                                                 |
| Register a hand-over at the counter              | OPERATIONS, ACCOUNTANT, SUPER_ADMIN (`SETTLEMENT_RECORDER_ROLES`)                      |
| See settlements                                  | SUPER_ADMIN, ACCOUNTANT, OWNER_VIEWER, OPERATIONS                                      |
| See driver custody balances                      | SUPER_ADMIN, ACCOUNTANT, OWNER_VIEWER (unchanged)                                      |
| Count, confirm or reject a settlement            | ACCOUNTANT only (`CASH_COUNT_ROLES`), never the registrant or driver                   |
| Record a cash discrepancy (driver cash shortage) | ACCOUNTANT only                                                                        |
| Approve a cash shortage                          | A second finance user (ADR 0001 §5: not the proposer; SUPER_ADMIN above the threshold) |
| Driver repayment                                 | SUPER_ADMIN, ACCOUNTANT (unchanged)                                                    |

- A registered hand-over is `SUBMITTED`: nothing is posted until an accountant confirms the counted
  amount. SUPER_ADMIN monitors and audits but has no confirmation bypass in the API.
- An accountant who registered a hand-over cannot confirm or reject it (`403
SELF_APPROVAL_FORBIDDEN`); another accountant must.
- The custody model is unchanged: the counted amount (≤ declared) is cleared and posted; the
  difference stays in the driver's custody. Writing it off is a separate cash-shortage decision.
- The settlement keeps the initiator, the deciding accountant, both timestamps, declared and counted
  amounts; the API also returns the discrepancy (declared − counted). `SETTLEMENT_SUBMITTED` and
  `SETTLEMENT_CONFIRMED`/`REJECTED` audit records carry the same values.
- Concurrency: the settlement row is locked; a second decision gets `409 INVALID_STATE`. Confirmation
  is idempotent per Idempotency-Key and the posting is unique per settlement.

## 2. Return-fee policy

A pricing rule carries a return policy (part of the rule version):

| Policy                        | Charged for a returned shipment                |
| ----------------------------- | ---------------------------------------------- |
| `RETURN_ONLY` (default)       | The return fee                                 |
| `DELIVERY_PLUS_RETURN`        | The shipment's delivery fee + the return fee   |
| `REDUCED_ATTEMPT_PLUS_RETURN` | The rule's failed-attempt fee + the return fee |

- Precedence is the existing rule precedence (merchant route → general route → merchant fallback →
  general fallback). A merchant-specific rule therefore overrides the general policy for that merchant.
  A shipment priced without a rule (manual fee) is `RETURN_ONLY`.
- Configuration: SUPER_ADMIN and ACCOUNTANT (`PRICING_MANAGER_ROLES`); merchants cannot change it.
  Creating or revising a rule is audited with the policy and attempt fee. A revision without a policy
  keeps the current one.
- Validation (API and database check constraints): the attempt fee is required for, and only allowed
  with, `REDUCED_ATTEMPT_PLUS_RETURN`, and is between 0 and the rule's delivery fee.
- Migration: every existing rule, pricing snapshot and return record is `RETURN_ONLY` with no extra
  charge, which is exactly the previous behaviour. No row or journal entry is rewritten.

### When each amount is fixed and earned

1. **Pricing (shipment creation):** the shipment's pricing snapshot captures the rule's return fee,
   policy and attempt fee. Later rule changes never affect it.
2. **Delivery fee:** earned when the shipment is DELIVERED (`DELIVERY_FEE` entry, ADR 0001). DELIVERED
   is terminal; a returned shipment is never delivered, so its delivery fee is never posted that way.
3. **Return request:** the return record copies the policy and fixes the delivery part: the
   shipment's delivery fee (`DELIVERY_PLUS_RETURN`) or the attempt fee (`REDUCED_ATTEMPT_PLUS_RETURN`).
   From this point the delivery fee can no longer change (overrides are pre-delivery only).
4. **Payable:** when the shipment is RETURNED and the return fee is decided (configured, set, or
   waived). One `RETURN_FEE` entry posts everything: merchant balance debited by the total, return fee
   to `RETURN_FEE_REVENUE`, the delivery/attempt part to `DELIVERY_FEE_REVENUE`. The entry is unique
   per return record, so it is posted exactly once.

### Conservative choices where the commercial terms are silent

These never create a charge that was not explicitly configured:

- No delivery/attempt part without at least one failed delivery attempt (e.g. a return requested
  while the parcel was only picked up).
- One attempt fee per shipment, not per attempt.
- The attempt fee is capped at the shipment's delivery fee (relevant after a pre-delivery override).
- No delivery/attempt part when a delivery fee was already posted for the shipment.
- An unconfigured return fee still needs an explicit decision; the delivery part is posted with it.
- A waiver waives the whole return charge, including the delivery part.
- Posted return charges are final; corrections are financial adjustments (reversal and new posting),
  never edits.

## 3. Accounting note: merchant debit adjustments (no change)

`MERCHANT_DEBIT` adjustments credit `ADJUSTMENT_EXPENSE`, as ADR 0001 designs it (one net account for
goodwill credits and debits). The postings balance and the merchant balance, net income and all
reconciliation checks are correct, but a period with more debits than credits shows a negative
expense rather than income. This is a presentation issue, not a posting error. Options (pending the
owner's decision): label the line "net merchant adjustments", report credits and debits separately,
or post future debits to a new income account. Historical entries stay as they are.
