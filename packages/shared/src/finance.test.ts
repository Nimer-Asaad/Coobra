import { describe, expect, it } from 'vitest';
import { driverRepaymentSchema, normalizeReceiptReference } from './finance.js';
import { toFieldErrors } from './validation.js';

const driverId = '0199a1c2-7d3e-7f00-8000-0000000000d1';

describe('driver repayment receipt reference', () => {
  it('normalises spelling so one paper receipt has one reference', () => {
    expect(normalizeReceiptReference('  rc-١٠٠١ ')).toBe('RC-1001');
    expect(normalizeReceiptReference('trf  ۲۰۲۶/55')).toBe('TRF 2026/55');
    expect(normalizeReceiptReference('إيصال 7')).toBe('إيصال 7');
  });

  it('is required and validated', () => {
    const base = { driverId, amount: '10', channel: 'HUB' };
    const errors = (input: object) => {
      const result = driverRepaymentSchema.safeParse(input);
      return result.success ? {} : toFieldErrors(result.error);
    };
    expect(errors(base)).toEqual({ receiptReference: 'validation.finance.receiptReference' });
    for (const bad of ['', ' ', 'x', '#12', 'A'.repeat(65)]) {
      expect(errors({ ...base, receiptReference: bad })).toEqual({
        receiptReference: 'validation.finance.receiptReference',
      });
    }
    expect(driverRepaymentSchema.parse({ ...base, receiptReference: ' rc-1001 ' })).toMatchObject({
      receiptReference: 'RC-1001',
    });
  });
});
