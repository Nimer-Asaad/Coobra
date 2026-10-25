import { describe, expect, it } from 'vitest';
import { ERROR_CODES, GOVERNORATES, SHIPMENT_STATUSES } from '@coobra/shared';
import { ar, createI18n, en } from './index.js';

function flatKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' ? [`${prefix}${key}`] : flatKeys(child as object, `${prefix}${key}.`),
  );
}

describe('locales', () => {
  it('Arabic and English define the same keys', () => {
    expect(flatKeys(ar).sort()).toEqual(flatKeys(en).sort());
  });

  it('every API error code is translated', () => {
    for (const code of ERROR_CODES) {
      expect(en.errors).toHaveProperty(code);
      expect(ar.errors).toHaveProperty(code);
    }
  });

  it('translates every shipment status, action and governorate in both languages', () => {
    for (const locale of [ar, en]) {
      for (const status of SHIPMENT_STATUSES) {
        expect(locale.shipmentStatus).toHaveProperty(status);
        expect(locale.shipments.actions.to).toHaveProperty(status);
      }
      for (const governorate of GOVERNORATES) {
        expect(locale.governorates).toHaveProperty(governorate);
      }
    }
    const t = createI18n('ar').t;
    expect(t('shipmentStatus.DELIVERED')).toBe('تم التسليم');
    expect(t('shipments.created', { tracking: 'CB-12345678' })).toBe(
      'تم إنشاء الشحنة CB-12345678.',
    );
    expect(createI18n('en').t('errors.SHIPMENT_COD_MISMATCH')).toBe(
      'The collected amount does not match the cash on delivery.',
    );
  });

  it('translates synchronously with interpolation', () => {
    const t = createI18n('ar').t;
    expect(t('home.welcome', { name: 'نمر' })).toBe('مرحباً، نمر');
    expect(createI18n('en').t('validation.password.tooShort', { min: 10 })).toBe(
      'Password must be at least 10 characters.',
    );
  });
});
