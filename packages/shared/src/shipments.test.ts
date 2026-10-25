import { describe, expect, it } from 'vitest';
import {
  adminCreateShipmentSchema,
  availableShipmentTransitions,
  codConfirmationSchema,
  createShipmentSchema,
  findShipmentTransition,
  isTerminalShipmentStatus,
  normalizeMoney,
  normalizePhone,
  SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  shipmentActorForRole,
  shipmentPhoneSchema,
  TERMINAL_SHIPMENT_STATUSES,
} from './shipments.js';
import { toFieldErrors } from './validation.js';

const validShipment = {
  recipientName: 'أحمد خليل',
  recipientPhone: '0599 123 456',
  destinationZoneId: '0199a1c2-7d3e-7f00-8000-0000000000aa',
  city: 'البيرة',
  addressLine: 'شارع القدس، عمارة 5',
  codAmount: '150',
};

describe('phone numbers', () => {
  it.each([
    ['0599123456', '0599123456'],
    ['059-912-3456', '0599123456'],
    ['٠٥٩٩١٢٣٤٥٦', '0599123456'],
    ['+970 599 123 456', '+970599123456'],
    ['00970599123456', '+970599123456'],
    ['+972 52 123 4567', '+972521234567'],
    ['02 295 1234', '022951234'],
    ['+962791234567', '+962791234567'],
  ])('accepts %s', (input, expected) => {
    expect(shipmentPhoneSchema.parse(input)).toBe(expected);
  });

  it.each(['12345', 'abc0599123456', '+0599123456', '0599', '05991234567890'])(
    'rejects %s',
    (input) => {
      const result = shipmentPhoneSchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  it('normalises Persian digits and the 00 prefix', () => {
    expect(normalizePhone('۰۰۹۷۰۵۹۹۱۲۳۴۵۶')).toBe('+970599123456');
  });
});

describe('money', () => {
  it.each([
    ['150', '150.00'],
    ['150.5', '150.50'],
    [99.99, '99.99'],
    ['١٢٠', '120.00'],
    ['0', '0.00'],
    ['1,250', '1250.00'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeMoney(input)).toBe(expected);
  });

  it.each(['-5', '1.234', 'abc', '', Number.NaN, null])('rejects %s', (input) => {
    expect(normalizeMoney(input)).toBeNull();
  });
});

describe('createShipmentSchema', () => {
  it('normalises a valid shipment and drops blank optional fields', () => {
    const result = createShipmentSchema.parse({
      ...validShipment,
      landmark: '  ',
      merchantId: 'x',
    });
    expect(result).toMatchObject({ recipientPhone: '0599123456', codAmount: '150.00' });
    expect(result.landmark).toBeUndefined();
    expect(result).not.toHaveProperty('merchantId');
    expect(result).not.toHaveProperty('deliveryFee');
  });

  it('returns translatable field errors', () => {
    const result = createShipmentSchema.safeParse({
      ...validShipment,
      recipientPhone: '123',
      destinationZoneId: 'PARIS',
      codAmount: '-1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFieldErrors(result.error)).toEqual({
        recipientPhone: 'validation.phone.invalid',
        destinationZoneId: 'validation.zone.required',
        codAmount: 'validation.money.invalid',
      });
    }
  });

  it('rejects amounts above the limit', () => {
    const result = createShipmentSchema.safeParse({ ...validShipment, codAmount: '100000.01' });
    expect(result.success).toBe(false);
  });
});

describe('adminCreateShipmentSchema', () => {
  it('requires a merchant; a manual fee is an override that needs a reason', () => {
    const merchantId = '0199a1c2-7d3e-7f00-8000-000000000001';
    expect(adminCreateShipmentSchema.safeParse(validShipment).success).toBe(false);
    expect(
      adminCreateShipmentSchema.parse({ ...validShipment, merchantId, manualFee: '' }).manualFee,
    ).toBeUndefined();
    const noReason = adminCreateShipmentSchema.safeParse({
      ...validShipment,
      merchantId,
      manualFee: '20',
    });
    expect(noReason.success).toBe(false);
    if (!noReason.success) {
      expect(toFieldErrors(noReason.error)).toEqual({
        manualFeeReason: 'validation.reason.required',
      });
    }
    expect(
      adminCreateShipmentSchema.parse({
        ...validShipment,
        merchantId,
        manualFee: '20',
        manualFeeReason: 'Special contract',
      }).manualFee,
    ).toBe('20.00');
  });
});

describe('codConfirmationSchema', () => {
  it('requires an explicit confirmation', () => {
    expect(codConfirmationSchema.safeParse({ collected: true, amount: '10' }).success).toBe(false);
    expect(
      codConfirmationSchema.safeParse({ collected: true, amount: '10', confirmed: true }).success,
    ).toBe(true);
  });
});

describe('lifecycle', () => {
  it('has no transitions out of terminal statuses', () => {
    for (const status of TERMINAL_SHIPMENT_STATUSES) {
      expect(SHIPMENT_TRANSITIONS.filter((rule) => rule.from === status)).toEqual([]);
      expect(isTerminalShipmentStatus(status)).toBe(true);
    }
  });

  it('only lets drivers mark shipments delivered, with COD confirmation', () => {
    const rule = findShipmentTransition('OUT_FOR_DELIVERY', 'DELIVERED');
    expect(rule?.actors).toEqual(['DRIVER']);
    expect(rule?.requiresCodConfirmation).toBe(true);
    for (const status of SHIPMENT_STATUSES) {
      expect(
        availableShipmentTransitions(status, 'MERCHANT').some((r) => r.to === 'DELIVERED'),
      ).toBe(false);
    }
  });

  it('requires reasons for failures, returns and cancellations', () => {
    for (const rule of SHIPMENT_TRANSITIONS) {
      if (['DELIVERY_FAILED', 'RETURN_REQUESTED', 'CANCELLED'].includes(rule.to)) {
        expect(rule.requiresReason).toBe(true);
      }
    }
  });

  it('prevents status jumps', () => {
    expect(findShipmentTransition('CREATED', 'DELIVERED')).toBeUndefined();
    expect(findShipmentTransition('ASSIGNED', 'OUT_FOR_DELIVERY')).toBeUndefined();
    expect(findShipmentTransition('DELIVERED', 'RETURNED')).toBeUndefined();
  });

  it('maps roles to actors; read-only roles cannot act', () => {
    expect(shipmentActorForRole('OPERATIONS')).toBe('STAFF');
    expect(shipmentActorForRole('SUPER_ADMIN')).toBe('STAFF');
    expect(shipmentActorForRole('OWNER_VIEWER')).toBeNull();
    expect(shipmentActorForRole('ACCOUNTANT')).toBeNull();
    expect(shipmentActorForRole('MERCHANT')).toBe('MERCHANT');
  });
});
