// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { USER_ROLES, type UserRole } from '@coobra/shared';
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
});
