import { z } from 'zod';
import type { UserRole } from './roles.js';
import type { Currency } from './shipments.js';
import { moneySchema, optionalMoneySchema, toAsciiDigits } from './shipments.js';

/*
 * Phase 3 pricing contracts: zones, pricing rules, quotes, snapshots and fee overrides.
 * Money travels as decimal strings ("12.50"); it is never computed with JS numbers.
 */

export const PRICING_SOURCES = [
  'MERCHANT_ROUTE',
  'GENERAL_ROUTE',
  'MERCHANT_FALLBACK',
  'GENERAL_FALLBACK',
  'MANUAL',
  'LEGACY',
] as const;
export type PricingSource = (typeof PRICING_SOURCES)[number];

/** Roles that manage the zone tree. */
export const ZONE_MANAGER_ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS',
] as const satisfies readonly UserRole[];
/** Roles that manage pricing rules (commercial decisions). */
export const PRICING_MANAGER_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
] as const satisfies readonly UserRole[];
/** Roles that may override a fee before delivery. */
export const FEE_OVERRIDE_ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS',
] as const satisfies readonly UserRole[];

/** How long a merchant quote stays valid. */
export const QUOTE_TTL_MINUTES = 15;

export const MAX_RULE_FEE = 10_000;

const zoneName = z
  .string({ error: 'validation.required' })
  .trim()
  .min(1, { error: 'validation.required' })
  .max(120, { error: 'validation.name.tooLong' });

/** Stable identifiers: upper-case letters, digits and underscores (e.g. RAMALLAH_ALBIREH). */
export const zoneCodeSchema = z
  .string({ error: 'validation.required' })
  .trim()
  .transform((value) => toAsciiDigits(value).toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, { error: 'validation.zone.code' }));

export const createZoneKindSchema = z.object({
  code: zoneCodeSchema,
  nameAr: zoneName,
  nameEn: zoneName,
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
});
export type CreateZoneKindInput = z.infer<typeof createZoneKindSchema>;

export const updateZoneKindSchema = createZoneKindSchema.omit({ code: true }).partial();
export type UpdateZoneKindInput = z.infer<typeof updateZoneKindSchema>;

export const createZoneSchema = z.object({
  code: zoneCodeSchema,
  kindId: z.uuid({ error: 'validation.zone.kind' }),
  parentId: z.uuid({ error: 'validation.zone.parent' }).optional(),
  nameAr: zoneName,
  nameEn: zoneName,
  sortOrder: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type CreateZoneInput = z.infer<typeof createZoneSchema>;

/** The parent and code are fixed after creation; names, status and order can change. */
export const updateZoneSchema = z
  .object({
    nameAr: zoneName,
    nameEn: zoneName,
    active: z.boolean(),
    sortOrder: z.coerce.number().int().min(0).max(100_000),
  })
  .partial();
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

const optionalDate = z.iso.datetime({ offset: true, error: 'validation.date.invalid' }).optional();

export const createPricingRuleSchema = z
  .object({
    merchantId: z.uuid({ error: 'validation.merchant.required' }).optional(),
    originZoneId: z.uuid({ error: 'validation.zone.required' }).optional(),
    destinationZoneId: z.uuid({ error: 'validation.zone.required' }).optional(),
    isFallback: z.boolean().default(false),
    deliveryFee: moneySchema(MAX_RULE_FEE),
    /** Omit to leave the return fee unconfigured (RETURN_FEE_UNCONFIGURED on returns). */
    returnFee: optionalMoneySchema(MAX_RULE_FEE),
    priority: z.coerce.number().int().min(-1000).max(1000).default(0),
    effectiveFrom: optionalDate,
    effectiveTo: optionalDate,
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.isFallback && (rule.originZoneId || rule.destinationZoneId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['isFallback'],
        message: 'validation.pricing.fallbackZones',
      });
    }
    if (!rule.isFallback) {
      if (!rule.originZoneId) {
        ctx.addIssue({
          code: 'custom',
          path: ['originZoneId'],
          message: 'validation.zone.required',
        });
      }
      if (!rule.destinationZoneId) {
        ctx.addIssue({
          code: 'custom',
          path: ['destinationZoneId'],
          message: 'validation.zone.required',
        });
      }
    }
    if (rule.effectiveFrom && rule.effectiveTo && rule.effectiveTo <= rule.effectiveFrom) {
      ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'validation.date.order' });
    }
  });
export type CreatePricingRuleInput = z.infer<typeof createPricingRuleSchema>;

/** A revision replaces the fees/priority/window; the route and merchant stay the same. */
export const revisePricingRuleSchema = z.object({
  deliveryFee: moneySchema(MAX_RULE_FEE),
  returnFee: optionalMoneySchema(MAX_RULE_FEE),
  priority: z.coerce.number().int().min(-1000).max(1000).default(0),
  effectiveTo: optionalDate,
  note: z.string().trim().max(500).optional(),
});
export type RevisePricingRuleInput = z.infer<typeof revisePricingRuleSchema>;

export const quoteRequestSchema = z.object({
  originZoneId: z.uuid({ error: 'validation.zone.required' }).optional(),
  destinationZoneId: z.uuid({ error: 'validation.zone.required' }),
});
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

export const adminQuoteRequestSchema = quoteRequestSchema.extend({
  merchantId: z.uuid({ error: 'validation.merchant.required' }),
});
export type AdminQuoteRequestInput = z.infer<typeof adminQuoteRequestSchema>;

export const reasonTextSchema = z
  .string({ error: 'validation.reason.required' })
  .trim()
  .min(3, { error: 'validation.reason.required' })
  .max(500, { error: 'validation.text.tooLong' });

export const feeOverrideSchema = z.object({
  fee: moneySchema(MAX_RULE_FEE),
  reason: reasonTextSchema,
});
export type FeeOverrideInput = z.infer<typeof feeOverrideSchema>;

export const pickupZoneSchema = z.object({
  zoneId: z.uuid({ error: 'validation.zone.required' }),
});
export type PickupZoneInput = z.infer<typeof pickupZoneSchema>;

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface ZoneKindItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
}

export interface ZoneItem {
  id: string;
  code: string;
  kindId: string;
  parentId: string | null;
  depth: number;
  nameAr: string;
  nameEn: string;
  active: boolean;
  sortOrder: number;
}

/** A zone with its full path for display, e.g. "Ramallah & Al-Bireh / Al-Bireh". */
export interface ZoneLabel {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  pathAr: string;
  pathEn: string;
}

export interface PricingRuleItem {
  id: string;
  ruleGroupId: string;
  version: number;
  merchant: { id: string; businessName: string } | null;
  originZone: ZoneLabel | null;
  destinationZone: ZoneLabel | null;
  isFallback: boolean;
  deliveryFee: string;
  returnFee: string | null;
  currency: Currency;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  note: string | null;
  createdAt: string;
}

export interface PricingQuote {
  /** Present for persisted (merchant) quotes; pass it when creating the shipment. */
  quoteId: string | null;
  origin: ZoneLabel;
  destination: ZoneLabel;
  ruleId: string;
  ruleVersion: number;
  source: PricingSource;
  merchantSpecific: boolean;
  baseFee: string;
  finalFee: string;
  returnFee: string | null;
  currency: Currency;
  quotedAt: string;
  expiresAt: string | null;
}

export interface FeeOverrideItem {
  id: string;
  phase: 'PRE_DELIVERY' | 'POST_DELIVERY';
  status: 'APPLIED' | 'PENDING_APPROVAL' | 'REJECTED';
  previousFee: string | null;
  newFee: string;
  reason: string;
  actor: { id: string; fullName: string; role: UserRole };
  approvedBy: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface ShipmentPricingInfo {
  source: PricingSource;
  ruleId: string | null;
  ruleVersion: number | null;
  origin: ZoneLabel | null;
  destination: ZoneLabel | null;
  baseFee: string | null;
  finalFee: string;
  returnFee: string | null;
  pricedAt: string;
  overrides: FeeOverrideItem[];
}
