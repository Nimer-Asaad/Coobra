import { z } from 'zod';
import type { UserRole } from './roles.js';

/*
 * Phase 4B audit log viewer (SUPER_ADMIN only, read only).
 *
 * Every audit entry has an action, an optional actor and target user, and a JSON metadata
 * object written by the service that performed the change. The viewer never returns metadata
 * as stored: it passes through an allowlist with secret redaction (see the API's
 * audit-redaction.ts), and the IP address and user agent appear only in the detail view.
 */

export const AUDIT_ACTIONS = [
  'AUTH_REGISTERED',
  'AUTH_LOGIN_SUCCEEDED',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'AUTH_PASSWORD_RESET_REQUESTED',
  'AUTH_PASSWORD_RESET_COMPLETED',
  'AUTH_EMAIL_VERIFIED',
  'USER_CREATED',
  'USER_PREFERENCES_UPDATED',
  'USER_PROFILE_UPDATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_ROLE_CHANGED',
  'SHIPMENT_CREATED',
  'SHIPMENT_ASSIGNED',
  'SHIPMENT_STATUS_CHANGED',
  'SHIPMENT_CANCELLED',
  'ZONE_KIND_CREATED',
  'ZONE_KIND_UPDATED',
  'ZONE_CREATED',
  'ZONE_UPDATED',
  'PRICING_RULE_CREATED',
  'PRICING_RULE_REVISED',
  'PRICING_RULE_DEACTIVATED',
  'MERCHANT_PICKUP_ZONE_SET',
  'PICKUP_ZONE_CHANGE_REQUESTED',
  'PICKUP_ZONE_REQUEST_WITHDRAWN',
  'PICKUP_ZONE_CHANGE_APPROVED',
  'PICKUP_ZONE_CHANGE_REJECTED',
  'SHIPMENT_FEE_OVERRIDDEN',
  'FINANCE_SETTING_CHANGED',
  'COD_COLLECTED',
  'SHORTFALL_PROPOSED',
  'SHORTFALL_APPROVED',
  'SHORTFALL_REJECTED',
  'SHORTFALL_MERCHANT_ACCEPTED',
  'SHORTFALL_MERCHANT_DECLINED',
  'FEE_CORRECTION_REQUESTED',
  'FEE_CORRECTION_APPROVED',
  'FEE_CORRECTION_REJECTED',
  'ADJUSTMENT_REQUESTED',
  'ADJUSTMENT_APPROVED',
  'ADJUSTMENT_REJECTED',
  'SETTLEMENT_SUBMITTED',
  'SETTLEMENT_CONFIRMED',
  'SETTLEMENT_REJECTED',
  'DRIVER_SHORTAGE_PROPOSED',
  'DRIVER_SHORTAGE_APPROVED',
  'DRIVER_SHORTAGE_REJECTED',
  'DRIVER_REPAYMENT_RECORDED',
  'PAYOUT_CREATED',
  'PAYOUT_APPROVED',
  'PAYOUT_PAID',
  'PAYOUT_CANCELLED',
  'MERCHANT_PAYMENT_RECORDED',
  'TREASURY_TRANSFER',
  'RETURN_APPROVED',
  'RETURN_FEE_SET',
  'RETURN_FEE_WAIVED',
  'RETURN_CLOSED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_CATEGORIES = [
  'AUTH',
  'USERS',
  'SHIPMENTS',
  'PRICING',
  'FINANCE',
  'RETURNS',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

const PRICING_PREFIXES = ['ZONE_', 'PRICING_', 'MERCHANT_PICKUP_', 'PICKUP_ZONE_'];

/** Accepts any string: entries written before an action was renamed still get a category. */
export function auditCategory(action: string): AuditCategory {
  if (action.startsWith('AUTH_')) return 'AUTH';
  if (action.startsWith('USER_')) return 'USERS';
  if (action.startsWith('RETURN_')) return 'RETURNS';
  if (action === 'SHIPMENT_FEE_OVERRIDDEN') return 'FINANCE';
  if (action.startsWith('SHIPMENT_')) return 'SHIPMENTS';
  if (PRICING_PREFIXES.some((prefix) => action.startsWith(prefix))) return 'PRICING';
  // Everything else (COD, shortfalls, settlements, payouts, ...) is money.
  return 'FINANCE';
}

export function actionsInCategory(category: AuditCategory): AuditAction[] {
  return AUDIT_ACTIONS.filter((action) => auditCategory(action) === category);
}

/**
 * What an entry is about. USER is the entry's target user; every other type is the metadata
 * key that holds its id (the first one present, in this order, names the entity).
 */
export const AUDIT_ENTITY_KEYS = {
  SHIPMENT: 'shipmentId',
  SETTLEMENT: 'settlementId',
  PAYOUT: 'payoutId',
  MERCHANT_PAYMENT: 'paymentId',
  TREASURY_TRANSFER: 'transferId',
  SHORTFALL: 'shortfallId',
  DRIVER_SHORTAGE: 'shortageId',
  DRIVER_REPAYMENT: 'repaymentId',
  ADJUSTMENT: 'adjustmentId',
  FEE_OVERRIDE: 'overrideId',
  COD_COLLECTION: 'collectionId',
  PRICING_RULE: 'ruleId',
  PICKUP_ZONE_REQUEST: 'requestId',
  ZONE: 'zoneId',
  ZONE_KIND: 'zoneKindId',
  SESSION: 'sessionId',
} as const;
export const AUDIT_ENTITY_TYPES = ['USER', ...Object.keys(AUDIT_ENTITY_KEYS)] as [
  'USER',
  ...(keyof typeof AUDIT_ENTITY_KEYS)[],
];
export type AuditEntityType = 'USER' | keyof typeof AUDIT_ENTITY_KEYS;

export const AUDIT_PAGE_SIZE_MAX = 100;

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));
const optionalUuid = optionalText.pipe(z.uuid({ error: 'validation.audit.id' }).optional());
const optionalDate = optionalText.pipe(
  z.iso.datetime({ offset: true, error: 'validation.audit.date' }).optional(),
);

export const listAuditLogsQuerySchema = z
  .object({
    /** An entry/user/entity id, a tracking number, a receipt or payment reference, or a person. */
    q: optionalText.pipe(z.string().max(100, { error: 'validation.text.tooLong' }).optional()),
    category: z.enum(AUDIT_CATEGORIES, { error: 'validation.audit.category' }).optional(),
    action: z.enum(AUDIT_ACTIONS, { error: 'validation.audit.action' }).optional(),
    actorId: optionalUuid,
    targetUserId: optionalUuid,
    entityType: z.enum(AUDIT_ENTITY_TYPES, { error: 'validation.audit.entityType' }).optional(),
    entityId: optionalText.pipe(z.string().max(100).optional()),
    /** Inclusive start and exclusive end (ISO date-time with offset). */
    from: optionalDate,
    to: optionalDate,
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(25),
  })
  // Compares instants, not strings (the offsets may differ).
  .refine((query) => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to), {
    path: ['to'],
    error: 'validation.audit.dateRange',
  })
  .refine((query) => !query.entityId || query.entityType, {
    path: ['entityType'],
    error: 'validation.audit.entityType',
  });
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export interface AuditPerson {
  id: string;
  fullName: string;
  role: UserRole;
}

export interface AuditEntity {
  type: AuditEntityType;
  id: string;
}

/** A JSON value after redaction. */
export type AuditValue =
  | string
  | number
  | boolean
  | null
  | AuditValue[]
  | { [key: string]: AuditValue };

export interface AuditChange {
  field: string;
  before: AuditValue;
  after: AuditValue;
}

export interface AuditLogListItem {
  id: string;
  action: string;
  category: AuditCategory;
  createdAt: string;
  actor: AuditPerson | null;
  targetUser: AuditPerson | null;
  entity: AuditEntity | null;
  /** A short, safe hint for the table (tracking number, reference, reason). */
  summary: string | null;
}

export interface AuditLogDetails extends AuditLogListItem {
  ipAddress: string | null;
  userAgent: string | null;
  /** Before/after pairs the entry records (profile edits, role and status changes, ...). */
  changes: AuditChange[];
  /** The other metadata fields, redacted. */
  details: Record<string, AuditValue>;
  /** Paths of fields whose values were withheld (secrets or fields the viewer doesn't know). */
  redacted: string[];
}
