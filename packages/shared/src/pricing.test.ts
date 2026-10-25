import { describe, expect, it } from 'vitest';
import {
  createPricingRuleSchema,
  createZoneSchema,
  feeOverrideSchema,
  revisePricingRuleSchema,
} from './pricing.js';
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
});
