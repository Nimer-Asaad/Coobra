// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdjustmentItem, ImpersonationInfo, UserDetails } from '@coobra/shared';
import { AdjustmentSourceLabel } from '@/components/finance/adjustment-source';
import { bff } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { ActiveImpersonationBar } from './active-impersonation-bar';
import { ImpersonateAction } from './impersonate-action';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(),
}));
const bffMock = vi.mocked(bff);
const FIRST_RENDER = { timeout: 5_000 };
const APPS = { MERCHANT: 'http://localhost:8082', DRIVER: 'http://localhost:8081' };

const merchant = (overrides: Partial<UserDetails> = {}): UserDetails => ({
  id: 'm-1',
  email: 'shop@example.com',
  fullName: 'Jenin Sweets',
  phone: null,
  role: 'MERCHANT',
  status: 'ACTIVE',
  language: 'ar',
  emailVerified: true,
  merchant: { businessName: 'Jenin Sweets' },
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdBy: null,
  lastSignInAt: null,
  activeSessions: 0,
  history: [],
  ...overrides,
});

const active = (overrides: Partial<ImpersonationInfo> = {}): ImpersonationInfo => ({
  id: 'imp-1',
  actor: { id: 'admin-1', fullName: 'Rana Admin' },
  target: { id: 'm-1', fullName: 'Jenin Sweets', role: 'MERCHANT' },
  startedAt: '2026-10-30T10:00:00.000Z',
  expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  endedAt: null,
  endedReason: null,
  serverNow: new Date().toISOString(),
  writesEnabled: false,
  ...overrides,
});

function serveActive(items: ImpersonationInfo[]) {
  bffMock.mockImplementation(async (path: string) => {
    if (path === '/v1/admin/impersonations?active=true') return items;
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  bffMock.mockReset();
});

describe('ImpersonateAction', () => {
  it('requires a reason and the password before opening anything', async () => {
    serveActive([]);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderWithProviders(
      <ImpersonateAction user={merchant()} currentUserId="admin-1" appUrls={APPS} />,
    );
    const start = await screen.findByRole('button', { name: 'Act as this account' }, FIRST_RENDER);
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    await user.click(start);
    expect(screen.getByRole('dialog', { name: 'Act as Jenin Sweets' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText('Please write a reason (at least 3 characters).')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(bffMock).not.toHaveBeenCalledWith('/v1/auth/reauthenticate', expect.anything());
    open.mockRestore();
  });

  it('opens the app in the click and starts nothing when the browser blocks the tab', async () => {
    serveActive([]);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderWithProviders(
      <ImpersonateAction user={merchant()} currentUserId="admin-1" appUrls={APPS} />,
    );
    const start = await screen.findByRole('button', { name: 'Act as this account' }, FIRST_RENDER);
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    await user.click(start);
    await user.type(screen.getByLabelText('Reason'), 'Merchant asked for help on the phone');
    await user.type(screen.getByLabelText('Your password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(open).toHaveBeenCalledWith('http://localhost:8082/impersonate', 'coobra-impersonation');
    expect(await screen.findByText(/The browser blocked the new tab/)).toBeTruthy();
    // No password check and no start: nothing is left active.
    const paths = bffMock.mock.calls.map(([path]) => path);
    expect(new Set(paths)).toEqual(new Set(['/v1/admin/impersonations?active=true']));
    expect((screen.getByLabelText('Your password') as HTMLInputElement).value).toBe('');
    open.mockRestore();
  });

  it('stays visible but disabled, with the reason, when it is not possible', async () => {
    serveActive([active({ actor: { id: 'admin-2', fullName: 'Other Admin' } })]);
    renderWithProviders(
      <ImpersonateAction user={merchant()} currentUserId="admin-1" appUrls={APPS} />,
    );
    expect(
      await screen.findByText(
        'Another administrator is acting as this account right now.',
        {},
        FIRST_RENDER,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Act as this account' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('explains staff and inactive accounts', async () => {
    serveActive([]);
    const { unmount } = renderWithProviders(
      <ImpersonateAction
        user={merchant({ role: 'ACCOUNTANT' })}
        currentUserId="admin-1"
        appUrls={APPS}
      />,
    );
    expect(screen.getByText('Staff accounts cannot be impersonated.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Act as this account' })).toBeNull();
    unmount();
    renderWithProviders(
      <ImpersonateAction
        user={merchant({ status: 'DISABLED' })}
        currentUserId="admin-1"
        appUrls={APPS}
      />,
      'ar',
    );
    expect(
      await screen.findByText('يمكن الدخول بالحسابات الفعالة فقط.', {}, FIRST_RENDER),
    ).toBeTruthy();
  });
});

describe('ActiveImpersonationBar', () => {
  it('shows my active session with the time left and ends it', async () => {
    const mine = active();
    bffMock.mockImplementation(async (path: string) => {
      if (path === '/v1/admin/impersonations?active=true') return [mine];
      if (path === '/v1/admin/impersonations/imp-1/end')
        return { ...mine, endedAt: mine.serverNow };
      throw new Error(`unexpected ${path}`);
    });
    renderWithProviders(<ActiveImpersonationBar currentUserId="admin-1" />);
    const bar = await screen.findByRole(
      'region',
      { name: 'Your active impersonation' },
      FIRST_RENDER,
    );
    expect(bar.textContent).toContain('You are acting as Jenin Sweets (Merchant) in another tab.');
    expect(bar.textContent).toMatch(/Time left: 1[12]:\d\d/);
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() =>
      expect(bffMock).toHaveBeenCalledWith('/v1/admin/impersonations/imp-1/end', {
        method: 'POST',
      }),
    );
  });

  it('shows nothing for another admin’s session', async () => {
    serveActive([active({ actor: { id: 'admin-2', fullName: 'Other' } })]);
    renderWithProviders(<ActiveImpersonationBar currentUserId="admin-1" />);
    await waitFor(() => expect(bffMock).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('AdjustmentSourceLabel', () => {
  const item = (overrides: Partial<AdjustmentItem>): AdjustmentItem => ({
    id: 'adj-1',
    type: 'MERCHANT_CREDIT',
    merchant: { id: 'm-1', fullName: 'Jenin Sweets', businessName: 'Jenin Sweets' },
    amount: '5.00',
    reason: 'Fee refund',
    status: 'PENDING_APPROVAL',
    requestedBy: { id: 'acc-1', fullName: 'Accountant' },
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: '2026-10-30T10:00:00.000Z',
    sourceType: 'UNLINKED',
    sourceShipment: null,
    sourceJournalEntryId: null,
    ...overrides,
  });

  it('shows what an adjustment is linked to', () => {
    renderWithProviders(
      <AdjustmentSourceLabel
        item={item({
          sourceType: 'SHIPMENT_FEE',
          sourceShipment: { id: 's-1', trackingNumber: 'CB-12345678' },
        })}
      />,
    );
    expect(screen.getByText('A shipment fee')).toBeTruthy();
    expect(screen.getByText('CB-12345678')).toBeTruthy();
  });

  it('marks unlinked adjustments, in Arabic too', () => {
    renderWithProviders(<AdjustmentSourceLabel item={item({})} />, 'ar');
    expect(screen.getByText('غير مرتبطة')).toBeTruthy();
  });
});
