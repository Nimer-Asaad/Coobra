import { describe, expect, it } from 'vitest';
import {
  adminQuoteRequestSchema,
  createPricingRuleSchema,
  createZoneSchema,
  feeOverrideSchema,
  quoteRequestSchema,
  revisePricingRuleSchema,
} from './pricing.js';
import { adminCreateShipmentSchema, createShipmentSchema, moneyToCents } from './shipments.js';
import { toFieldErrors } from './validation.js';

const zoneA = '0199a1c2-7d3e-7f00-8000-0000000000a1';
const zoneB = '0199a1c2-7d3e-7f00-8000-0000000000b2';

describe('createPricingRuleSchema', () => {
  it('normalises fees and leaves the return fee unconfigured when omitted', () => {
    const rule = createPricingRuleSchema.parse({
      originZoneId: zoneA,
      destinationZoneId: zoneB,
      deliveryFee: '٢٥',
    });
    expect(rule).toMatchObject({ deliveryFee: '25.00', isFallback: false, priority: 0 });
    expect(rule.returnFee).toBeUndefined();
  });

  it('requires both zones for route rules and none for fallbacks', () => {
    const route = createPricingRuleSchema.safeParse({ originZoneId: zoneA, deliveryFee: '10' });
    expect(route.success).toBe(false);
    if (!route.success) {
      expect(toFieldErrors(route.error)).toEqual({ destinationZoneId: 'validation.zone.required' });
    }
    const fallback = createPricingRuleSchema.safeParse({
      isFallback: true,
      originZoneId: zoneA,
      deliveryFee: '10',
    });
    expect(fallback.success).toBe(false);
    expect(createPricingRuleSchema.safeParse({ isFallback: true, deliveryFee: '10' }).success).toBe(
      true,
    );
  });

  it('rejects negative fees and inverted effective windows', () => {
    expect(createPricingRuleSchema.safeParse({ isFallback: true, deliveryFee: '-1' }).success).toBe(
      false,
    );
    const window = createPricingRuleSchema.safeParse({
      isFallback: true,
      deliveryFee: '10',
      effectiveFrom: '2026-11-01T00:00:00Z',
      effectiveTo: '2026-10-01T00:00:00Z',
    });
    expect(window.success).toBe(false);
  });

  it('revises fees only (route and merchant are fixed)', () => {
    const revised = revisePricingRuleSchema.parse({ deliveryFee: 30, originZoneId: zoneB });
    expect(revised).toEqual({ deliveryFee: '30.00', priority: 0 });
  });
});

describe('zones and overrides', () => {
  it('uses stable upper-case codes', () => {
    const zone = createZoneSchema.parse({
      code: 'nablus_city',
      kindId: zoneA,
      nameAr: 'نابلس',
      nameEn: 'Nablus',
    });
    expect(zone.code).toBe('NABLUS_CITY');
    expect(
      createZoneSchema.safeParse({ code: 'نابلس', kindId: zoneA, nameAr: 'x', nameEn: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires a reason for fee overrides', () => {
    const result = feeOverrideSchema.safeParse({ fee: '20' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFieldErrors(result.error)).toEqual({ reason: 'validation.reason.required' });
    }
  });

  it('lets only staff choose the pricing origin', () => {
    expect(quoteRequestSchema.parse({ destinationZoneId: zoneB, originZoneId: zoneA })).toEqual({
      destinationZoneId: zoneB,
    });
    const shipment = {
      recipientName: 'Recipient',
      recipientPhone: '0599123456',
      destinationZoneId: zoneB,
      originZoneId: zoneA,
      addressLine: 'Street 1',
      codAmount: '0',
    };
    expect(createShipmentSchema.parse(shipment)).not.toHaveProperty('originZoneId');
    expect(adminCreateShipmentSchema.parse({ ...shipment, merchantId: zoneA }).originZoneId).toBe(
      zoneA,
    );
    expect(
      adminQuoteRequestSchema.parse({
        merchantId: zoneA,
        originZoneId: zoneA,
        destinationZoneId: zoneB,
      }).originZoneId,
    ).toBe(zoneA);
  });
});

describe('return-fee policy on pricing rules', () => {
  const route = { originZoneId: zoneA, destinationZoneId: zoneB, deliveryFee: '20' };
  const errors = (
    input: object,
    schema:
      | typeof createPricingRuleSchema
      | typeof revisePricingRuleSchema = createPricingRuleSchema,
  ) => {
    const result = schema.safeParse(input);
    return result.success ? {} : toFieldErrors(result.error);
  };

  it('defaults to RETURN_ONLY without an attempt fee', () => {
    const rule = createPricingRuleSchema.parse(route);
    expect(rule.returnPolicy).toBe('RETURN_ONLY');
    expect(rule.attemptFee).toBeUndefined();
  });

  it('requires an attempt fee (at most the delivery fee) only for the reduced policy', () => {
    const reduced = { ...route, returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN' };
    expect(errors(reduced)).toEqual({ attemptFee: 'validation.pricing.attemptFeeRequired' });
    expect(errors({ ...reduced, attemptFee: '20.01' })).toEqual({
      attemptFee: 'validation.pricing.attemptFeeTooHigh',
    });
    expect(createPricingRuleSchema.parse({ ...reduced, attemptFee: '٢٠' })).toMatchObject({
      attemptFee: '20.00',
    });
    expect(errors({ ...route, returnPolicy: 'DELIVERY_PLUS_RETURN', attemptFee: '5' })).toEqual({
      attemptFee: 'validation.pricing.attemptFeeNotAllowed',
    });
    expect(errors({ ...route, returnPolicy: 'FREE_RETURNS' })).toEqual({
      returnPolicy: 'validation.pricing.returnPolicy',
    });
  });

  it('keeps the policy on revision unless a new one is given', () => {
    expect(revisePricingRuleSchema.parse({ deliveryFee: '20' }).returnPolicy).toBeUndefined();
    expect(errors({ deliveryFee: '20', attemptFee: '5' }, revisePricingRuleSchema)).toEqual({
      returnPolicy: 'validation.pricing.returnPolicy',
    });
    expect(
      revisePricingRuleSchema.parse({
        deliveryFee: '20',
        returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
        attemptFee: '5',
      }),
    ).toMatchObject({ returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN', attemptFee: '5.00' });
  });
});

describe('moneyToCents', () => {
  it('compares normalised amounts exactly', () => {
    expect(moneyToCents('0.10') + moneyToCents('0.20')).toBe(moneyToCents('0.30'));
    expect(moneyToCents('1234567.89')).toBe(123456789n);
    expect(moneyToCents('5')).toBe(500n);
  });
});
