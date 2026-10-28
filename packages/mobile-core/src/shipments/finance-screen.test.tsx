import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MerchantFinanceSummary, PayoutItem } from '@coobra/shared';
import type { ApiClient } from '../api-client';
import { ApiContext } from '../api-context';
import { renderMobile } from '../test/render';
import { FinanceScreen } from './finance-screen';

const person = { id: 'm-1', fullName: 'Merchant' };
const payout = (status: PayoutItem['status']): PayoutItem => ({
  id: 'payout-1',
  merchant: { ...person, businessName: 'Shop' },
  amount: '5.00',
  method: 'CASH',
  status,
  requestedByMerchant: true,
  note: null,
  createdBy: person,
  approvedBy: null,
  approvedAt: null,
  paidBy: null,
  paidAt: null,
  reference: null,
  cancelledBy: null,
  cancelledAt: null,
  cancelReason: null,
  createdAt: '2026-10-26T10:00:00.000Z',
});

/** An in-memory merchant finance API: requesting adds a payout, withdrawing cancels it. */
function fakeApi() {
  let payouts: PayoutItem[] = [];
  const request = vi.fn(async (path: string, options: { method?: string } = {}) => {
    if (path === '/v1/merchant/finance/shortfalls') return [];
    if (path === '/v1/merchant/finance') {
      const summary: MerchantFinanceSummary = {
        pending: '0.00',
        balance: '21.00',
        reserved: '0.00',
        available: '21.00',
        payouts,
      };
      return summary;
    }
    if (path === '/v1/merchant/finance/payouts' && options.method === 'POST') {
      payouts = [payout('PENDING_APPROVAL')];
      return payouts[0];
    }
    if (path.endsWith('/cancel')) {
      payouts = [payout('CANCELLED')];
      return payouts[0];
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  });
  return { request } as unknown as ApiClient & { request: typeof request };
}

describe('Merchant finance: payout request and withdrawal feedback', () => {
  it('confirms the request, then clears that notice once the request is withdrawn', async () => {
    const api = fakeApi();
    renderMobile(
      <ApiContext.Provider value={api}>
        <FinanceScreen />
      </ApiContext.Provider>,
    );
    fireEvent.change(await screen.findByLabelText('Amount (₪)'), { target: { value: '5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Request a payout' }).at(-1)!);
    expect(await screen.findByText('Payout requested.')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(screen.queryByText('Payout requested.')).toBeNull());
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(api.request).toHaveBeenCalledWith('/v1/merchant/finance/payouts/payout-1/cancel', {
      method: 'POST',
      body: { note: 'Withdrawn by merchant' },
    });
  });
});
