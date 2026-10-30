import { z } from 'zod';
import { reasonTextSchema } from './pricing.js';
import type { UserRole } from './roles.js';
import { MAX_COD_AMOUNT, moneySchema, toAsciiDigits, type Currency } from './shipments.js';

/*
 * Phase 3 finance contracts. Amounts are decimal strings; balances follow the ledger sign
 * convention (see docs/adr/0001): a positive merchant balance is owed to the merchant.
 */

/** Settlements, payouts, adjustments, shortfall approvals and finance settings. */
export const FINANCE_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT'] as const satisfies readonly UserRole[];
/** Read-only financial visibility (reports, balances, journal). */
export const FINANCE_VIEW_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OWNER_VIEWER',
] as const satisfies readonly UserRole[];
/**
 * May register a driver's declared cash hand-over at the counter. The settlement stays
 * SUBMITTED until an accountant counts the cash (CASH_COUNT_ROLES).
 */
export const SETTLEMENT_RECORDER_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OPERATIONS',
] as const satisfies readonly UserRole[];
/**
 * Counting cash is the accountant's job: only an accountant confirms or rejects a driver
 * settlement, records a cash discrepancy (shortage) and posts a driver's debt repayment. A
 * settlement is never decided by the person who registered it.
 */
export const CASH_COUNT_ROLES = ['ACCOUNTANT'] as const satisfies readonly UserRole[];
/** May see driver settlements (operations see what they registered and its outcome). */
export const SETTLEMENT_VIEW_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OWNER_VIEWER',
  'OPERATIONS',
] as const satisfies readonly UserRole[];
/** May propose how a recipient shortfall is resolved (approval is a separate person). */
export const SHORTFALL_PROPOSER_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OPERATIONS',
] as const satisfies readonly UserRole[];

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const COD_STATUSES = [
  'NOT_REQUIRED',
  'PENDING',
  'PARTIAL',
  'COLLECTED',
  'SHORTFALL_RESOLVED',
] as const;
export type CodStatus = (typeof COD_STATUSES)[number];

export const SHORTFALL_STATUSES = [
  'OPEN',
  'PENDING_APPROVAL',
  'AWAITING_MERCHANT',
  'RESOLVED',
] as const;
export type ShortfallStatus = (typeof SHORTFALL_STATUSES)[number];

export const SHORTFALL_RESOLUTIONS = [
  'COLLECTED',
  'COMPANY_ABSORBS',
  'DRIVER_RESPONSIBLE',
  'MERCHANT_ACCEPTS',
] as const;
export type ShortfallResolution = (typeof SHORTFALL_RESOLUTIONS)[number];

/** Resolutions a staff member may propose (COLLECTED happens by collecting). */
export const PROPOSABLE_SHORTFALL_RESOLUTIONS = [
  'COMPANY_ABSORBS',
  'DRIVER_RESPONSIBLE',
  'MERCHANT_ACCEPTS',
] as const satisfies readonly ShortfallResolution[];

export const FINANCE_SETTING_KEYS = ['APPROVAL_THRESHOLD'] as const;
export type FinanceSettingKey = (typeof FINANCE_SETTING_KEYS)[number];

const note = z
  .string()
  .trim()
  .max(500, { error: 'validation.text.tooLong' })
  .optional()
  .transform((value) => (value ? value : undefined));

/** A follow-up collection for a partially paid shipment. */
export const codCollectionSchema = z.object({
  amount: moneySchema(MAX_COD_AMOUNT),
  note,
});
export type CodCollectionInput = z.infer<typeof codCollectionSchema>;

export const proposeShortfallSchema = z.object({
  resolution: z.enum(PROPOSABLE_SHORTFALL_RESOLUTIONS, { error: 'validation.finance.resolution' }),
  note: reasonTextSchema,
});
export type ProposeShortfallInput = z.infer<typeof proposeShortfallSchema>;

export const decisionSchema = z.object({ note });
export type DecisionInput = z.infer<typeof decisionSchema>;

export const rejectionSchema = z.object({ note: reasonTextSchema });
export type RejectionInput = z.infer<typeof rejectionSchema>;

/** ADR 0003 §10.4: what an adjustment corrects (checked again by the database). */
export const ADJUSTMENT_SOURCE_TYPES = [
  'SHIPMENT_FEE',
  'RETURN_CHARGE',
  'COD_SHORTFALL',
  'JOURNAL_ENTRY',
  'UNLINKED',
] as const;
export type AdjustmentSourceType = (typeof ADJUSTMENT_SOURCE_TYPES)[number];

export const adjustmentSchema = z
  .object({
    type: z.enum(['MERCHANT_CREDIT', 'MERCHANT_DEBIT'], {
      error: 'validation.finance.adjustmentType',
    }),
    merchantId: z.uuid({ error: 'validation.merchant.required' }),
    amount: moneySchema(MAX_COD_AMOUNT),
    reason: reasonTextSchema,
    // Optional provenance; without it the adjustment is UNLINKED (independent reviewer needed).
    sourceType: z
      .enum(ADJUSTMENT_SOURCE_TYPES, { error: 'validation.finance.adjustmentSource' })
      .default('UNLINKED'),
    sourceShipmentId: z.uuid({ error: 'validation.finance.adjustmentSource' }).optional(),
    sourceJournalEntryId: z.uuid({ error: 'validation.finance.adjustmentSource' }).optional(),
  })
  .refine(
    (input) =>
      input.sourceType === 'UNLINKED'
        ? !input.sourceShipmentId && !input.sourceJournalEntryId
        : input.sourceType === 'JOURNAL_ENTRY'
          ? Boolean(input.sourceJournalEntryId)
          : Boolean(input.sourceShipmentId),
    { path: ['sourceType'], error: 'validation.finance.adjustmentSource' },
  );
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const feeCorrectionSchema = z.object({
  fee: moneySchema(10_000),
  reason: reasonTextSchema,
});
export type FeeCorrectionInput = z.infer<typeof feeCorrectionSchema>;

export const updateFinanceSettingSchema = z.object({
  value: moneySchema(1_000_000),
  reason: reasonTextSchema,
});
export type UpdateFinanceSettingInput = z.infer<typeof updateFinanceSettingSchema>;

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface PersonRef {
  id: string;
  fullName: string;
}

export interface CodShortfallItem {
  id: string;
  shipment: { id: string; trackingNumber: string };
  merchant: PersonRef & { businessName: string };
  driver: PersonRef;
  expectedAmount: string;
  collectedAmount: string;
  outstandingAmount: string;
  reason: string;
  status: ShortfallStatus;
  proposedResolution: ShortfallResolution | null;
  proposedAmount: string | null;
  proposalNote: string | null;
  proposedBy: PersonRef | null;
  proposedAt: string | null;
  resolution: ShortfallResolution | null;
  resolvedAmount: string | null;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  merchantAcceptedAt: string | null;
  createdAt: string;
  currency: Currency;
}

export interface AdjustmentItem {
  id: string;
  type: 'MERCHANT_CREDIT' | 'MERCHANT_DEBIT';
  merchant: PersonRef & { businessName: string };
  amount: string;
  reason: string;
  status: 'APPLIED' | 'PENDING_APPROVAL' | 'REJECTED';
  requestedBy: PersonRef;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface FinanceSettingItem {
  key: FinanceSettingKey;
  value: string;
  updatedAt: string;
  updatedBy: PersonRef | null;
  history: {
    oldValue: string | null;
    newValue: string;
    reason: string;
    changedBy: PersonRef;
    createdAt: string;
  }[];
}

export interface CodCollectionItem {
  id: string;
  amount: string;
  clearedAmount: string;
  driver: PersonRef;
  note: string | null;
  recordedAt: string;
}

/** COD progress for a shipment (separate from its delivery status). */
export interface ShipmentCodInfo {
  status: CodStatus;
  expected: string;
  collected: string;
  outstanding: string;
  collections: CodCollectionItem[];
  shortfall: { id: string; status: ShortfallStatus; resolution: ShortfallResolution | null } | null;
}

// ---------------------------------------------------------------------------
// Driver settlements, cash shortages and repayments
// ---------------------------------------------------------------------------

export const CASH_CHANNELS = ['HUB', 'BANK', 'EWALLET'] as const;
export type CashChannel = (typeof CASH_CHANNELS)[number];

const channel = z.enum(CASH_CHANNELS, { error: 'validation.finance.method' }).default('HUB');

/** The driver declares how much cash they are handing over. */
export const submitSettlementSchema = z.object({
  declaredAmount: moneySchema(1_000_000),
  note,
});
export type SubmitSettlementInput = z.infer<typeof submitSettlementSchema>;

/** A finance user records a settlement at the counter on the driver's behalf. */
export const staffSettlementSchema = submitSettlementSchema.extend({
  driverId: z.uuid({ error: 'validation.driver.required' }),
});
export type StaffSettlementInput = z.infer<typeof staffSettlementSchema>;

/** The counted amount is cleared (≤ declared); the rest stays in the driver's custody. */
export const confirmSettlementSchema = z.object({
  countedAmount: moneySchema(1_000_000),
  channel,
  /** Clear these shipments' collections first; otherwise oldest collections first. */
  shipmentIds: z.array(z.uuid()).max(500).optional(),
  note,
});
export type ConfirmSettlementInput = z.infer<typeof confirmSettlementSchema>;

export const driverShortageSchema = z.object({
  driverId: z.uuid({ error: 'validation.driver.required' }),
  amount: moneySchema(1_000_000),
  responsibility: z.enum(['DRIVER_LIABLE', 'COMPANY_ABSORBS'], {
    error: 'validation.finance.resolution',
  }),
  reason: reasonTextSchema,
});
export type DriverShortageInput = z.infer<typeof driverShortageSchema>;

/**
 * Normalises a receipt / transfer reference so the same paper receipt cannot be entered twice
 * with different spelling: ASCII digits, upper case, single spaces.
 */
export function normalizeReceiptReference(value: string): string {
  return toAsciiDigits(value).trim().replace(/\s+/g, ' ').toUpperCase();
}

export const receiptReferenceSchema = z
  .string({ error: 'validation.finance.receiptReference' })
  .transform(normalizeReceiptReference)
  .pipe(
    z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} ./#-]{1,63}$/u, {
      error: 'validation.finance.receiptReference',
    }),
  );

export const driverRepaymentSchema = z.object({
  driverId: z.uuid({ error: 'validation.driver.required' }),
  amount: moneySchema(1_000_000),
  channel,
  /** The receipt number (cash) or transfer reference (bank, e-wallet) of this payment. */
  receiptReference: receiptReferenceSchema,
  note,
});
export type DriverRepaymentInput = z.infer<typeof driverRepaymentSchema>;

export interface SettlementItem {
  id: string;
  driver: PersonRef;
  status: 'SUBMITTED' | 'CONFIRMED' | 'REJECTED';
  declaredAmount: string;
  countedAmount: string | null;
  /** Declared minus counted once confirmed (what stayed in the driver's custody). */
  discrepancy: string | null;
  channel: CashChannel;
  note: string | null;
  submittedBy: PersonRef & { role: UserRole };
  decidedBy: (PersonRef & { role: UserRole }) | null;
  decidedAt: string | null;
  decisionNote: string | null;
  clearings: { shipment: { id: string; trackingNumber: string }; amount: string }[];
  createdAt: string;
}

export interface DriverShortageItem {
  id: string;
  driver: PersonRef;
  amount: string;
  responsibility: 'DRIVER_LIABLE' | 'COMPANY_ABSORBS';
  reason: string;
  status: 'APPLIED' | 'PENDING_APPROVAL' | 'REJECTED';
  proposedBy: PersonRef;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface UnclearedCollection {
  collectionId: string;
  shipment: { id: string; trackingNumber: string };
  amount: string;
  uncleared: string;
  recordedAt: string;
}

/** What a driver sees about their own cash. */
export interface DriverFinanceSummary {
  custody: string;
  receivable: string;
  pendingSettlement: SettlementItem | null;
  uncleared: UnclearedCollection[];
  settlements: SettlementItem[];
}

export interface DriverBalanceRow {
  driver: PersonRef & { phone: string | null };
  custody: string;
  receivable: string;
  pendingSettlement: string | null;
}

// ---------------------------------------------------------------------------
// Merchant payouts, merchant payments and treasury transfers
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'E_WALLET', 'CHEQUE'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PayoutStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'CANCELLED';

/** Where the money for each payout method comes from. */
export const PAYMENT_METHOD_CHANNEL: Record<PaymentMethod, CashChannel> = {
  CASH: 'HUB',
  BANK_TRANSFER: 'BANK',
  CHEQUE: 'BANK',
  E_WALLET: 'EWALLET',
};

const method = z.enum(PAYMENT_METHODS, { error: 'validation.finance.method' });

/** A merchant asks for a payout (finance decides). */
export const payoutRequestSchema = z.object({
  amount: moneySchema(1_000_000),
  method,
  note,
});
export type PayoutRequestInput = z.infer<typeof payoutRequestSchema>;

/** A finance user creates a payout for a merchant (another person approves it). */
export const createPayoutSchema = payoutRequestSchema.extend({
  merchantId: z.uuid({ error: 'validation.merchant.required' }),
});
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;

export const markPayoutPaidSchema = z.object({
  reference: z
    .string({ error: 'validation.finance.reference' })
    .trim()
    .min(2, { error: 'validation.finance.reference' })
    .max(120, { error: 'validation.text.tooLong' }),
  note,
});
export type MarkPayoutPaidInput = z.infer<typeof markPayoutPaidSchema>;

export const merchantPaymentSchema = z.object({
  merchantId: z.uuid({ error: 'validation.merchant.required' }),
  amount: moneySchema(1_000_000),
  channel: z.enum(CASH_CHANNELS, { error: 'validation.finance.method' }),
  reference: z.string().trim().max(120).optional(),
  note,
});
export type MerchantPaymentInput = z.infer<typeof merchantPaymentSchema>;

export const treasuryTransferSchema = z
  .object({
    fromChannel: z.enum(CASH_CHANNELS, { error: 'validation.finance.method' }),
    toChannel: z.enum(CASH_CHANNELS, { error: 'validation.finance.method' }),
    amount: moneySchema(10_000_000),
    reference: z.string().trim().max(120).optional(),
  })
  .refine((value) => value.fromChannel !== value.toChannel, {
    path: ['toChannel'],
    error: 'validation.finance.sameChannel',
  });
export type TreasuryTransferInput = z.infer<typeof treasuryTransferSchema>;

export interface PayoutItem {
  id: string;
  merchant: PersonRef & { businessName: string };
  amount: string;
  method: PaymentMethod;
  status: PayoutStatus;
  requestedByMerchant: boolean;
  note: string | null;
  createdBy: PersonRef;
  approvedBy: PersonRef | null;
  approvedAt: string | null;
  paidBy: PersonRef | null;
  paidAt: string | null;
  reference: string | null;
  cancelledBy: PersonRef | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

/**
 * A merchant's money. `pending` is COD collected but not yet received from the driver;
 * `balance` is funded (positive = owed to the merchant, negative = the merchant owes);
 * `reserved` is approved but unpaid payouts; `available` = max(balance − reserved, 0).
 */
export interface MerchantFinanceSummary {
  pending: string;
  balance: string;
  reserved: string;
  available: string;
  payouts: PayoutItem[];
}

export interface MerchantBalanceRow extends Omit<MerchantFinanceSummary, 'payouts'> {
  merchant: PersonRef & { businessName: string };
}

// ---------------------------------------------------------------------------
// Reports and reconciliation
// ---------------------------------------------------------------------------

/** A ledger figure recomputed from operational records; `difference` must be "0.00". */
export interface ReconciliationCheck {
  key:
    | 'TRIAL_BALANCE'
    | 'DRIVER_CUSTODY'
    | 'MERCHANT_COD_PENDING'
    | 'MERCHANT_PAYOUTS'
    | 'MERCHANT_ADJUSTMENTS';
  ledger: string;
  operational: string;
  difference: string;
}

/**
 * Approved merchant settlement adjustments in a period. The ledger keeps them in one net
 * account (ADJUSTMENT_EXPENSE, ADR 0001); reports show each direction as a positive amount:
 * credits to merchants (debited to the account) and debits to merchants (credited to it).
 */
export interface MerchantAdjustmentTotals {
  credits: string;
  creditCount: number;
  debits: string;
  debitCount: number;
  /** credits − debits: positive = net credited to merchants, negative = net charged to them. */
  net: string;
}

export interface FinanceOverview {
  companyCash: Record<CashChannel, string>;
  driverCustody: string;
  driverReceivables: string;
  merchantPending: string;
  /** Sum of positive merchant balances (owed to merchants). */
  merchantOwed: string;
  /** Sum of negative merchant balances (merchants owe the company). */
  merchantOwing: string;
  reservedPayouts: string;
  /** COD still unpaid by recipients on partially paid shipments. */
  recipientOutstanding: string;
  period: {
    from: string | null;
    to: string | null;
    deliveryFees: string;
    returnFees: string;
    codShortfallExpense: string;
    driverCashLossExpense: string;
    merchantAdjustments: MerchantAdjustmentTotals;
  };
  queues: {
    shortfallsOpen: number;
    settlementsSubmitted: number;
    driverShortagesPending: number;
    payoutsPending: number;
    payoutsApproved: number;
    adjustmentsPending: number;
    feeCorrectionsPending: number;
    returnsFeeUnconfigured: number;
    /** Phase 2 records not yet posted to the ledger: excluded from every balance until backfilled. */
    legacyCollectionsUnposted: number;
    legacyFeesUnposted: number;
  };
  reconciliation: ReconciliationCheck[];
}

export interface JournalEntryItem {
  id: string;
  kind: string;
  description: string | null;
  reversalOfId: string | null;
  createdBy: PersonRef | null;
  createdAt: string;
  lines: {
    account: string;
    purpose: string;
    side: 'DEBIT' | 'CREDIT';
    amount: string;
    trackingNumber: string | null;
  }[];
}

export const CSV_REPORTS = [
  'merchant-balances',
  'driver-balances',
  'journal',
  'delivered-shipments',
  'merchant-adjustments',
] as const;
export type CsvReport = (typeof CSV_REPORTS)[number];
