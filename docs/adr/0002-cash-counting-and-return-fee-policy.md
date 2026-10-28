# ADR 0002 — Accountant-controlled driver cash, configurable return-fee policy and adjustment reporting

- Status: accepted. Owner-approved on 2026-10-28: accountant cash counting, configurable return
  policies, and (final financial decisions) the three conservative return rules, accountant-only
  debt repayment and separate merchant adjustment reporting.
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
| Receive and post a driver debt repayment         | ACCOUNTANT only (`CASH_COUNT_ROLES`)                                                   |

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

### Driver debt repayment (approved)

- A repayment reduces the driver's debt (`DRIVER_RECEIVABLE`) when cash is received. Only an
  ACCOUNTANT posts it, checked by the route and again by the service; SUPER_ADMIN, OPERATIONS,
  OWNER_VIEWER, DRIVER and MERCHANT get `403`. There is no non-posting request step (not needed).
- The amount must be positive and at most the outstanding debt (`422 INSUFFICIENT_FUNDS`); there is
  no approved rule for overpayment. The receivable is locked, so concurrent repayments cannot
  overpay; the Idempotency-Key makes a retried request return the first result (one posting).
- **Receipt reference (pre-merge safeguard):** every new repayment carries the number of the real
  payment: the cash receipt number or the bank / e-wallet transfer reference. It is normalised
  (trimmed, ASCII digits, upper case, single spaces) and unique per channel by a database index
  (`driver_repayments_channel_receipt_reference_key`). Reusing it for any other repayment (another
  accountant, another key, another amount or driver) is refused with
  `validation.finance.referenceTaken`; two accountants posting the same receipt at once get one
  posting. Separate payments with their own receipts are separate repayments even when the amounts
  are equal. The same number on another channel is another document. Repayments recorded before
  this change keep a NULL reference (NULLs never conflict); none is rewritten.
- Each repayment row keeps the driver, amount, channel, receipt reference, the accountant (`recorded_by_id`), the time
  and its journal entry; the `DRIVER_REPAYMENT_RECORDED` audit record adds the debt account and the
  outstanding debt before and after. Historical repayments are unchanged.

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

### Approved return rules (owner-approved 2026-10-28)

1. **No attempt fee without a failed attempt:** no delivery/attempt part unless the shipment has at
   least one DELIVERY_FAILED (e.g. none for a return requested while the parcel was only picked up).
2. **At most one attempt fee per shipment,** however many attempts failed.
3. **A waiver waives every return-related charge,** including the delivery/attempt part; a waived
   return cannot be charged afterwards.

Further safeguards (never create a charge that was not explicitly configured):

- The attempt fee is capped at the shipment's delivery fee (relevant after a pre-delivery override).
- No delivery/attempt part when a delivery fee was already posted for the shipment.
- An unconfigured return fee still needs an explicit decision; the delivery part is posted with it.
- Posted return charges are final; corrections are financial adjustments (reversal and new posting),
  never edits.

## 3. Merchant settlement adjustments in reports (approved)

The accounting model is unchanged: a merchant credit posts Dr `ADJUSTMENT_EXPENSE` / Cr
`MERCHANT_BALANCE`; a merchant debit posts Dr `MERCHANT_BALANCE` / Cr `ADJUSTMENT_EXPENSE` (one net
settlement account, ADR 0001). No historical entry, direction or account is changed, and nothing is
reclassified as revenue.

Presentation:

- The finance overview shows a separate **Merchant settlement adjustments** section, no longer an
  expense line: credits to merchants (debit lines on the account) and debits to merchants (credit
  lines) as positive amounts with their counts, and the net in words ("net credited to merchants" /
  "net charged to merchants") with a positive magnitude.
- `merchant-adjustments.csv` lists every adjustment with `type`, `direction`
  (`credit_to_merchant` / `debit_to_merchant`), a positive `amount`, status, people and journal
  entry. The journal CSV is unchanged (account, side, positive amount).
- Reconciliation adds `MERCHANT_ADJUSTMENTS`: the net account's ledger balance against approved
  credits − approved debits from `financial_adjustments` (difference must be 0.00).

Limitation of the model: the account remains a single net account typed EXPENSE, so its raw ledger
balance (e.g. in the journal or a trial balance by account) is negative when debits exceed credits.
Reports now present it by direction; a separate income account would need a new accounting decision.
