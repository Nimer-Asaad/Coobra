import { z } from 'zod';
import { reasonTextSchema } from './pricing.js';
import type { UserRole } from './roles.js';
import { MAX_COD_AMOUNT, moneySchema, type Currency } from './shipments.js';

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

export const adjustmentSchema = z.object({
  type: z.enum(['MERCHANT_CREDIT', 'MERCHANT_DEBIT'], {
    error: 'validation.finance.adjustmentType',
  }),
  merchantId: z.uuid({ error: 'validation.merchant.required' }),
  amount: moneySchema(MAX_COD_AMOUNT),
  reason: reasonTextSchema,
});
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
