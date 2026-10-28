// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { MerchantAdjustmentsSummary } from './finance-panel';

const text = () =>
  screen.getByRole('region', { name: 'Merchant settlement adjustments' }).textContent ?? '';

describe('MerchantAdjustmentsSummary', () => {
  it('shows debits and credits as positive amounts and a net charge in words', () => {
    renderWithProviders(
      <MerchantAdjustmentsSummary
        totals={{ credits: '50.00', creditCount: 1, debits: '80.00', debitCount: 2, net: '-30.00' }}
      />,
    );
    const content = text();
    expect(content).toContain('Credits to merchants (1)');
    expect(content).toContain('Debits to merchants (2)');
    expect(content).toContain('Net charged to merchants');
    expect(content).not.toContain('-');
    // Never presented as an expense line.
    expect(content).not.toMatch(/expense/i);
  });

  it('labels a net credit and renders in Arabic', () => {
    renderWithProviders(
      <MerchantAdjustmentsSummary
        totals={{ credits: '90.00', creditCount: 2, debits: '10.00', debitCount: 1, net: '80.00' }}
      />,
      'ar',
    );
    const content = screen.getByRole('region', { name: 'تسويات أرصدة التجار' }).textContent ?? '';
    expect(content).toContain('صافي المضاف للتجار');
    expect(content).toContain('إضافات للتجار (2)');
  });
});
