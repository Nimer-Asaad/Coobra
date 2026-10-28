// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SettlementItem } from '@coobra/shared';
import { renderWithProviders } from '@/test/render';
import { SettlementRow } from './finance-panel';

const settlement = (overrides: Partial<SettlementItem> = {}): SettlementItem => ({
  id: 'settlement-1',
  driver: { id: 'driver-1', fullName: 'Driver One' },
  status: 'SUBMITTED',
  declaredAmount: '150.00',
  countedAmount: null,
  discrepancy: null,
  channel: 'HUB',
  note: null,
  submittedBy: { id: 'ops-1', fullName: 'Ops Person', role: 'OPERATIONS' },
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  clearings: [],
  createdAt: '2026-10-26T10:00:00.000Z',
  ...overrides,
});

const row = (item: SettlementItem, canCount: boolean, userId: string) => (
  <ul>
    <SettlementRow settlement={item} canCount={canCount} userId={userId} />
  </ul>
);

describe('SettlementRow (cash counting)', () => {
  it('lets an accountant confirm or reject a hand-over someone else registered', () => {
    renderWithProviders(row(settlement(), true, 'accountant-1'));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('gives no confirmation controls to non-accountants (super admin, operations, viewer)', () => {
    renderWithProviders(row(settlement(), false, 'admin-1'));
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('asks another accountant to count a hand-over the accountant registered', () => {
    renderWithProviders(
      row(
        settlement({ submittedBy: { id: 'acc-1', fullName: 'Me', role: 'ACCOUNTANT' } }),
        true,
        'acc-1',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(
      screen.getByText('You registered this hand-over; another accountant must count it.'),
    ).toBeTruthy();
  });

  it('shows the counted amount and the discrepancy once confirmed', () => {
    renderWithProviders(
      row(
        settlement({
          status: 'CONFIRMED',
          countedAmount: '140.00',
          discrepancy: '10.00',
          decidedBy: { id: 'acc-1', fullName: 'Accountant', role: 'ACCOUNTANT' },
          decidedAt: '2026-10-26T11:00:00.000Z',
        }),
        true,
        'acc-2',
      ),
    );
    const text = screen.getByRole('listitem').textContent ?? '';
    expect(text).toContain('Counted');
    expect(text).toContain('Difference');
    expect(text).toContain('10.00');
    expect(text).toContain('Decided by Accountant');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});
