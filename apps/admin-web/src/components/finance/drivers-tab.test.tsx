// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { USER_ROLES, type UserRole } from '@coobra/shared';
import { bff } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { driverCashAccess, DriversTab } from './finance-panel';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(async () => []),
}));

const REPAY = 'Record a driver repayment';
const RECORD = 'Record cash handed over at the counter';
const SHORTAGE = 'Report a driver cash shortage';

describe('Driver cash controls by role', () => {
  it('maps every role to its driver cash permissions', () => {
    const table = Object.fromEntries(USER_ROLES.map((role) => [role, driverCashAccess(role)]));
    expect(table).toEqual({
      SUPER_ADMIN: { canSeeMoney: true, canManage: true, canRecord: true, canCount: false },
      ACCOUNTANT: { canSeeMoney: true, canManage: true, canRecord: true, canCount: true },
      OWNER_VIEWER: { canSeeMoney: true, canManage: false, canRecord: false, canCount: false },
      OPERATIONS: { canSeeMoney: false, canManage: false, canRecord: true, canCount: false },
      DRIVER: { canSeeMoney: false, canManage: false, canRecord: false, canCount: false },
      MERCHANT: { canSeeMoney: false, canManage: false, canRecord: false, canCount: false },
    });
  });

  it.each([
    ['ACCOUNTANT', true, true],
    ['SUPER_ADMIN', false, true],
    ['OPERATIONS', false, true],
    ['OWNER_VIEWER', false, false],
  ] as [UserRole, boolean, boolean][])(
    '%s: repayment and shortage controls %s, counter hand-over %s',
    async (role, accountantControls, canRecord) => {
      renderWithProviders(<DriversTab {...driverCashAccess(role)} userId="me" />);
      await screen.findByText('Settlements');
      expect(Boolean(screen.queryByRole('button', { name: REPAY }))).toBe(accountantControls);
      expect(Boolean(screen.queryByRole('button', { name: SHORTAGE }))).toBe(accountantControls);
      expect(Boolean(screen.queryByRole('button', { name: RECORD }))).toBe(canRecord);
    },
  );

  it('sends the receipt or transfer number with the repayment', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DriversTab {...driverCashAccess('ACCOUNTANT')} userId="me" />);
    await user.click(await screen.findByRole('button', { name: REPAY }));
    expect(screen.getByText(/Each receipt can be used once/)).toBeTruthy();
    await user.type(screen.getByLabelText('Amount (₪)'), '4');
    await user.type(screen.getByLabelText('Receipt / transfer number'), 'rc-1001');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(vi.mocked(bff)).toHaveBeenCalledWith('/v1/admin/finance/driver-repayments', {
      method: 'POST',
      body: expect.objectContaining({ amount: '4', channel: 'HUB', receiptReference: 'rc-1001' }),
      idempotencyKey: expect.any(String),
    });
  });
});
