# Shipments (Phase 2)

Shipments, their lifecycle, driver assignment and the operational cash-on-delivery (COD) record.
Settlements, merchant payouts and accounting ledgers are **not** part of this phase.

## Who can do what

| Role         | Create                    | View                       | Change                                       |
| ------------ | ------------------------- | -------------------------- | -------------------------------------------- |
| MERCHANT     | Own shipments only        | Own shipments only         | Cancel (while `CREATED`), request a return   |
| SUPER_ADMIN  | On behalf of any merchant | All                        | Assign/reassign, cancel, returns             |
| OPERATIONS   | On behalf of any merchant | All                        | Assign/reassign, cancel, returns             |
| OWNER_VIEWER | —                         | All (read-only)            | —                                            |
| ACCOUNTANT   | —                         | All (read-only)            | —                                            |
| DRIVER       | —                         | Shipments assigned to them | Pick-up, out for delivery, delivered, failed |

- Every shipment belongs to a merchant (`merchant_id`). `created_by_id` and `creator_role` record the
  real person who created it: staff creating for a merchant is recorded as staff, never as the
  merchant (no silent impersonation).
- Merchants and drivers asking for a shipment they do not own get `404 NOT_FOUND`, so the existence
  of other merchants' shipments is never revealed. Query parameters such as `merchantId` are
  ignored for merchants and drivers.
- Merchants never set the delivery fee. Merchant-created shipments have `delivery_fee = NULL`
  ("to be priced") until pricing is introduced; staff may set it when creating a shipment.

## Lifecycle

```
CREATED ──assign──▶ ASSIGNED ──▶ PICKED_UP ──▶ OUT_FOR_DELIVERY ──▶ DELIVERED
   │                 │  ▲ reassign    │               │
   │ cancel          │ cancel         │ return        ▼
   ▼                 ▼                ▼          DELIVERY_FAILED ──retry──▶ OUT_FOR_DELIVERY
CANCELLED        CANCELLED     RETURN_REQUESTED ◀──return──┘   └──reassign──▶ ASSIGNED
                                      │
                                      ▼
                                   RETURNED
```

| From               | To                 | Who              | Requires                     |
| ------------------ | ------------------ | ---------------- | ---------------------------- |
| `CREATED`          | `ASSIGNED`         | Staff (assign)   | An active driver             |
| `ASSIGNED`         | `ASSIGNED`         | Staff (reassign) | Another active driver        |
| `DELIVERY_FAILED`  | `ASSIGNED`         | Staff (reassign) | An active driver             |
| `ASSIGNED`         | `PICKED_UP`        | Assigned driver  |                              |
| `PICKED_UP`        | `OUT_FOR_DELIVERY` | Assigned driver  | Increments delivery attempts |
| `OUT_FOR_DELIVERY` | `DELIVERED`        | Assigned driver  | COD confirmation             |
| `OUT_FOR_DELIVERY` | `DELIVERY_FAILED`  | Assigned driver  | Reason                       |
| `DELIVERY_FAILED`  | `OUT_FOR_DELIVERY` | Assigned driver  | (re-attempt)                 |
| `DELIVERY_FAILED`  | `RETURN_REQUESTED` | Merchant, staff  | Reason                       |
| `PICKED_UP`        | `RETURN_REQUESTED` | Staff            | Reason                       |
| `RETURN_REQUESTED` | `RETURNED`         | Staff            |                              |
| `CREATED`          | `CANCELLED`        | Merchant, staff  | Reason                       |
| `ASSIGNED`         | `CANCELLED`        | Staff            | Reason                       |

`DELIVERED`, `RETURNED` and `CANCELLED` are final: nothing can change them in Phase 2.
The table lives in `@coobra/shared` (`SHIPMENT_TRANSITIONS`) and is used by the API for
enforcement and by the clients to decide which buttons to show. Merchants and staff can never mark a
shipment delivered.

### Atomicity and concurrency

Each change runs in one database transaction that updates the shipment, appends a
`shipment_status_history` row and, for deliveries, inserts the `cod_collections` row. Updates use
optimistic concurrency: `UPDATE … WHERE id = ? AND version = ? AND status = ?` and the `version`
column is incremented. A concurrent writer receives `409 SHIPMENT_CONCURRENT_UPDATE` (or
`SHIPMENT_INVALID_TRANSITION` if the shipment already moved on) and the clients reload.

### Cash on delivery

To mark a shipment `DELIVERED` the driver must send
`cod: { collected, amount, confirmed: true }`. Nothing is assumed:

- If the expected COD is above zero, `collected` must be `true` and `amount` must equal it exactly.
- If the expected COD is zero, `collected` must be `false` and `amount` `0`.
- Anything else is rejected with `422 SHIPMENT_COD_MISMATCH`; the driver should report a failed
  delivery instead.

`cod_collections` stores the expected and collected amounts, the driver and the time. It is an
operational record that Phase 3 (driver cash reconciliation, merchant settlements) can reference
without rewriting shipment history. Money is `DECIMAL(12,2)` everywhere and travels as strings
(`"150.00"`) in the API.

## Data model

- `shipments` — tracking number (`CB-` + 8 digits, unique), merchant, creator and creator role,
  recipient, phones (normalised: `0599…` or `+970599…`), governorate code, city, address, landmark,
  notes, COD amount, delivery fee, currency (`ILS`), status, driver, timestamps, reasons, attempts,
  `version`. `CHECK` constraints keep amounts non-negative.
- `shipment_status_history` — append-only: from/to status, actor and actor role, assigned driver,
  note, time.
- `cod_collections` — see above.

Foreign keys use `RESTRICT`, so a shipment's history and COD records can never be deleted with it.

Phone numbers accept Arabic-Indic digits, spaces, dashes and the `00` prefix. Local numbers
(starting with `0`, 9–10 digits) and international E.164 numbers (`+970…`, `+972…`, …) are valid.

## API

All routes are under `/v1` and use the existing session authentication.

| Method & path                                  | Roles                   |
| ---------------------------------------------- | ----------------------- |
| `GET  /admin/shipments`                        | Staff (all four roles)  |
| `GET  /admin/shipments/summary`                | Staff                   |
| `GET  /admin/shipments/:id`                    | Staff                   |
| `POST /admin/shipments`                        | SUPER_ADMIN, OPERATIONS |
| `POST /admin/shipments/:id/assign`             | SUPER_ADMIN, OPERATIONS |
| `POST /admin/shipments/:id/transitions`        | SUPER_ADMIN, OPERATIONS |
| `GET  /admin/merchants?q=`                     | Staff (merchant picker) |
| `GET  /admin/drivers?q=`                       | Staff (driver picker)   |
| `GET  /merchant/shipments`                     | MERCHANT                |
| `GET  /merchant/shipments/:id`                 | MERCHANT                |
| `POST /merchant/shipments`                     | MERCHANT                |
| `POST /merchant/shipments/:id/transitions`     | MERCHANT                |
| `GET  /driver/shipments?scope=active\|history` | DRIVER                  |
| `GET  /driver/shipments/:id`                   | DRIVER                  |
| `POST /driver/shipments/:id/transitions`       | DRIVER                  |

Lists accept `q` (tracking number, recipient name or phone), `status`, `governorate`,
`merchantId`/`driverId` (staff only), `createdFrom`/`createdTo` (ISO date-times), `page` and
`pageSize` (max 100) and return `{ items, page, pageSize, total }`.

Audit log actions: `SHIPMENT_CREATED` (with `onBehalfOfMerchant`), `SHIPMENT_ASSIGNED`,
`SHIPMENT_STATUS_CHANGED`, `SHIPMENT_CANCELLED`. Shipment creation is rate limited to 60 requests per
minute per IP; everything else uses the global limit.

## Not in Phase 2

Editing shipment details after creation, pricing tables, partial deliveries, rescheduling dates,
return-to-merchant driver runs, background location tracking, settlements and payouts.
