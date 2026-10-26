# ADR 0001 — Phase 3: pricing, COD accounting, settlements, payouts and returns

- Status: accepted (2026-10-25), conditional approval items 1–8 incorporated
- Scope: Phase 3 only. Phase 1/2 behaviour is preserved unless stated here.

## 1. Pricing

- Zones are a database-managed hierarchy (`zones`, typed by configurable `zone_kinds`) with stable
  `code`s, Arabic/English names, parent, active flag and sort order. The 17 Phase 2 governorate codes
  are seeded as root zones; existing shipments keep their `governorate`/`city` text.
- A merchant has an approved pickup (origin) zone. Merchant quotes and shipments are always priced
  from it; only staff may price from another origin (see section 10).
- Rule precedence (first match wins): merchant route → general route → merchant fallback → general
  fallback → `422 PRICING_UNAVAILABLE`. A route rule matches when its origin/destination zone is the
  shipment's zone or one of its ancestors. Ties: deeper destination, deeper origin, higher `priority`,
  later `effective_from`, then `id`. No price is ever invented.
- Rules are versioned: an edit creates a new version and deactivates the old one. A rule has a
  delivery fee and an optional return fee (`NULL` = not configured).
- Quotes are persisted, single-use, valid for 15 minutes and bound to merchant, route, rule and rule
  version. On shipment creation the server re-prices; a mismatch returns `409 PRICE_CHANGED`.
- Every shipment stores a pricing snapshot; rule changes never alter it.
- Overrides always need a reason and are append-only. Before delivery: SUPER_ADMIN/OPERATIONS. After
  the fee is posted: a fee-correction adjustment (reverse + re-post) that needs a second approver.

## 2. Accounts and sign convention

Lines carry a positive amount and a side (DEBIT/CREDIT). Asset/expense balances = debits − credits;
liability/revenue balances = credits − debits.

| Account                           | Type      | Meaning                                                  |
| --------------------------------- | --------- | -------------------------------------------------------- |
| `COMPANY_CASH_HUB/BANK/EWALLET`   | asset     | Money the company actually holds, per channel            |
| `DRIVER_CUSTODY:{driver}`         | asset     | Collected cash still held by the driver                  |
| `DRIVER_RECEIVABLE:{driver}`      | asset     | Amount a driver owes after an approved decision          |
| `MERCHANT_COD_PENDING:{merchant}` | liability | COD collected for the merchant, cash not yet in company  |
| `MERCHANT_BALANCE:{merchant}`     | liability | Funded balance (credit = owed to merchant; debit = owes) |
| `DELIVERY_FEE_REVENUE`            | revenue   | Delivery fees                                            |
| `RETURN_FEE_REVENUE`              | revenue   | Return fees                                              |
| `COD_SHORTFALL_EXPENSE`           | expense   | Recipient shortfalls absorbed by the company             |
| `DRIVER_CASH_LOSS_EXPENSE`        | expense   | Driver cash shortages absorbed by the company            |
| `ADJUSTMENT_EXPENSE`              | expense   | Approved goodwill credits / debits to merchants          |

## 3. Postings

| Event                                 | Debit                                   | Credit                  |
| ------------------------------------- | --------------------------------------- | ----------------------- |
| COD collection c                      | DRIVER_CUSTODY c                        | MERCHANT_COD_PENDING c  |
| Delivered, fee F (once per shipment)  | MERCHANT_BALANCE F                      | DELIVERY_FEE_REVENUE F  |
| Driver settlement X (confirmed)       | COMPANY_CASH_x X                        | DRIVER_CUSTODY X        |
| …same entry, per cleared collection   | MERCHANT_COD_PENDING a                  | MERCHANT_BALANCE a      |
| Driver cash shortage S, driver liable | DRIVER_RECEIVABLE S (+ pending release) | DRIVER_CUSTODY S        |
| Driver cash shortage S, company       | DRIVER_CASH_LOSS_EXPENSE S (+ release)  | DRIVER_CUSTODY S        |
| Recipient shortfall R, company        | COD_SHORTFALL_EXPENSE R                 | MERCHANT_BALANCE R      |
| Recipient shortfall R, driver         | DRIVER_RECEIVABLE R                     | MERCHANT_BALANCE R      |
| Recipient shortfall, merchant accepts | — (merchant's explicit acceptance only) | —                       |
| Driver repays receivable              | COMPANY_CASH_x                          | DRIVER_RECEIVABLE       |
| Return completed, fee RF              | MERCHANT_BALANCE RF                     | RETURN_FEE_REVENUE RF   |
| Merchant payout P (paid)              | MERCHANT_BALANCE P                      | COMPANY_CASH_x P        |
| Merchant pays a debit balance         | COMPANY_CASH_x                          | MERCHANT_BALANCE        |
| Treasury transfer                     | COMPANY_CASH_to                         | COMPANY_CASH_from       |
| Merchant credit / debit adjustment    | ADJUSTMENT_EXPENSE / MERCHANT_BALANCE   | MERCHANT_BALANCE / ADJ. |
| Reversal of entry E                   | E's credits                             | E's debits              |

## 4. Invariants (enforced and tested)

1. Every entry balances (Σ debit = Σ credit), has ≥ 2 lines, one currency — checked by the service and
   by a deferred database constraint trigger.
2. `journal_entries` / `journal_lines` reject UPDATE and DELETE (triggers). Corrections are reversals.
3. One posting per business source: unique `(kind, source_type, source_id)`; a reversal is unique per
   reversed entry.
4. Σ collections per shipment ≤ expected COD; amounts > 0; negative or excess collections rejected.
5. Each collection is cleared at most once: `cleared_amount ≤ amount` (CHECK), allocations recorded.
6. `DRIVER_CUSTODY(d)` = Σ collections(d) − Σ cleared(d) ≥ 0.
7. `MERCHANT_COD_PENDING(m)` = Σ uncleared collections on m's shipments.
8. Payout available = `MERCHANT_BALANCE` credit − approved-unpaid payouts; a payout is only paid if
   the merchant is still funded and the chosen company cash account holds the amount.
9. Money-moving endpoints require `Idempotency-Key`; requests run in one transaction with row locks on
   the affected accounts, collections, settlements and payouts.

The reconciliation report recomputes 6–8 and the trial balance from operational tables and the ledger;
every difference must be zero.

## 5. Two different shortages (never assigned to the merchant automatically)

- **Recipient COD shortfall** — the recipient paid less than the COD. Delivery may be completed with a
  partial collection only with an explicit reason; the shipment's COD status becomes `PARTIAL` and a
  shortfall case opens. Outcomes: collected later, company absorbs, driver responsible, or merchant
  accepts (only through the merchant's own explicit acceptance).
- **Driver cash shortage** — the driver collected money but cannot hand it over. A finance user opens a
  case for an amount ≤ the driver's custody. Outcomes: driver liable or company absorbs. The merchant's
  pending COD is released to their balance either way, because the recipient did pay.

Both use proposer → approver: the approver must differ from the proposer. Up to the configurable
threshold (initially 200 ILS, `finance_settings`, SUPER_ADMIN only, audited) ACCOUNTANT or SUPER_ADMIN
may approve; above it SUPER_ADMIN only. The same rule applies to adjustments and fee corrections.

## 6. Driver settlements

Partial settlements are allowed. The driver (or a finance user at the counter) declares an amount; a
finance user counts and confirms the counted amount (≤ uncleared custody). Allocation happens at
confirmation, oldest collection first or to selected shipments. The difference between declared and
counted stays in custody. One open settlement per driver; a driver never confirms their own.

## 7. Merchant payouts

`PENDING_APPROVAL → APPROVED → PAID` (or `CANCELLED` before payment). The approver must differ from the
creator — no exception exists in Phase 3. Approval reserves funds; payment requires a unique reference
per method and posts the ledger entry. Merchants may request payouts and see only their own data.

## 8. Returns

Physical states: `RETURN_REQUESTED → RETURN_APPROVED → RETURN_IN_TRANSIT → (RETURNED_TO_HUB →)
RETURNED`; the Phase 2 direct `RETURN_REQUESTED → RETURNED` (collected at the office) is kept. The
return fee comes from the shipment's pricing snapshot; if none is configured the return record is
`RETURN_FEE_UNCONFIGURED` until SUPER_ADMIN/ACCOUNTANT sets a fee or approves a zero-fee waiver with a
reason. The fee is posted once the shipment is `RETURNED` and the fee is set. No delivery fee is charged
for returned shipments, and no money is reversed automatically.

## 9. Phase 2 data

Nothing is changed or deleted. Derived columns (COD status, collected total) are filled by the
migration. Ledger postings for Phase 2 collections and fees are produced only by
`pnpm finance:backfill-phase2`, which prints a dry-run report by default and posts only with
`--execute` after explicit owner approval.

## 10. Pre-merge hardening (2026-10-26)

- **One posting per source across posting paths.** The live path and the Phase 2 backfill use
  different journal kinds for the same source, which `(kind, source_type, source_id)` alone allows.
  Partial unique indexes allow one entry per COD collection (`source_type = 'cod_collection'`)
  and one per shipment delivery fee (`DELIVERY_FEE` or the backfilled `shipment_fee`). A violation
  surfaces as `409 DUPLICATE_POSTING`. Fee corrections (`FEE_ADJUSTMENT`) are not covered: they
  reverse the current fee entry, including a backfilled one, before re-posting.
- **Pickup zone changes need staff approval.** A merchant can only request a new pickup zone
  (`pickup_zone_requests`); the approved zone keeps pricing their shipments until SUPER_ADMIN or
  OPERATIONS approve it. At most one pending request per merchant (partial unique index); a new
  request replaces the pending one. The database rejects a decision by the requesting merchant and
  an approval or rejection without a staff decider. Staff can still set a zone directly. Existing
  approved zones are kept unchanged.
