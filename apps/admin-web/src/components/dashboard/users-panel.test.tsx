// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImpersonationInfo, Paginated, UserListItem } from '@coobra/shared';
import { bff } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { UsersPanel } from './users-panel';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/users',
  useSearchParams: () => search,
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(),
}));
const bffMock = vi.mocked(bff);

const item = (n: number, overrides: Partial<UserListItem> = {}): UserListItem => ({
  id: `user-${n}`,
  email: `user${n}@example.com`,
  fullName: `User ${n}`,
  phone: null,
  role: 'OPERATIONS',
  status: 'ACTIVE',
  emailVerified: true,
  businessName: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

function page(items: UserListItem[], total: number, pageNumber = 1): Paginated<UserListItem> {
  return { items, total, page: pageNumber, pageSize: 20 };
}

/** The users page, and the active impersonations the row actions check. */
function serveUsers(result: Paginated<UserListItem>, active: ImpersonationInfo[] = []) {
  bffMock.mockImplementation(async (path: string) =>
    path === '/v1/admin/impersonations?active=true' ? active : result,
  );
}

const APPS = { MERCHANT: 'http://localhost:8082', DRIVER: 'http://localhost:8081' };

beforeEach(() => {
  bffMock.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('UsersPanel', () => {
  it('lists users with links to their details', async () => {
    serveUsers(
      page([item(1), item(2, { role: 'MERCHANT', status: 'DISABLED', businessName: 'Shop' })], 2),
    );
    renderWithProviders(<UsersPanel />);
    const link = await screen.findByRole('link', { name: 'Open User 2' });
    expect(link.getAttribute('href')).toBe('/users/user-2');
    expect(screen.getByText('Shop')).toBeTruthy();
    expect(screen.getByText('2 users')).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith('/v1/admin/users?page=1&pageSize=20');
  });

  it('applies the search, role and status filters through the URL', async () => {
    const user = userEvent.setup();
    serveUsers(page([item(1)], 1));
    renderWithProviders(<UsersPanel />);
    await screen.findByRole('link', { name: 'Open User 1' });
    await user.type(screen.getByLabelText('Search by name, email, phone or business'), 'sara');
    await user.selectOptions(screen.getByLabelText('Role', { selector: '#users-role' }), 'DRIVER');
    await user.selectOptions(screen.getByLabelText('Status'), 'DISABLED');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(replace).toHaveBeenCalledWith('/users?q=sara&role=DRIVER&status=DISABLED');
  });

  it('sends the filters and page from the URL and pages through results', async () => {
    const user = userEvent.setup();
    search = new URLSearchParams('role=DRIVER&page=2');
    serveUsers(page([item(21)], 45, 2));
    renderWithProviders(<UsersPanel />);
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith('/v1/admin/users?page=2&pageSize=20&role=DRIVER');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(replace).toHaveBeenCalledWith('/users?role=DRIVER&page=3');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(replace).toHaveBeenLastCalledWith('/users?role=DRIVER&page=1');
  });

  it('says when nothing matches', async () => {
    serveUsers(page([], 0));
    renderWithProviders(<UsersPanel />);
    expect(await screen.findByText('No users yet.')).toBeTruthy();
  });

  it('renders in Arabic', async () => {
    serveUsers(page([item(1, { status: 'DISABLED' })], 1));
    renderWithProviders(<UsersPanel />, 'ar');
    expect(await screen.findByRole('link', { name: 'فتح User 1' })).toBeTruthy();
    expect(screen.getAllByText('معطّل').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'بحث' })).toBeTruthy();
  });

  it('offers "Act as this account" on active merchants and drivers only', async () => {
    serveUsers(
      page(
        [
          item(1),
          item(2, { role: 'MERCHANT', businessName: 'Shop' }),
          item(3, { role: 'DRIVER', status: 'DISABLED' }),
        ],
        3,
      ),
    );
    renderWithProviders(<UsersPanel currentUserId="admin-1" appUrls={APPS} />);
    const merchant = await screen.findByRole('button', { name: 'Act as this account (User 2)' });
    await waitFor(() => expect(merchant.hasAttribute('disabled')).toBe(false));
    // A disabled driver: visible, disabled, and the reason is linked to the button.
    const driver = screen.getByRole('button', { name: 'Act as this account (User 3)' });
    expect(driver.hasAttribute('disabled')).toBe(true);
    const reason = document.getElementById(driver.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Only active accounts can be impersonated.');
    // Staff rows have no such action.
    expect(screen.queryByRole('button', { name: /User 1/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Act as this account/ })).toHaveLength(2);
  });

  it('opens the same secure start dialog from the row', async () => {
    const user = userEvent.setup();
    serveUsers(page([item(2, { role: 'MERCHANT' })], 1));
    renderWithProviders(<UsersPanel currentUserId="admin-1" appUrls={APPS} />);
    const start = await screen.findByRole('button', { name: 'Act as this account (User 2)' });
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    await user.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Act as User 2' });
    expect(within(dialog).getByLabelText('Reason')).toBeTruthy();
    expect(within(dialog).getByLabelText('Your password')).toBeTruthy();
  });

  it('explains why a row cannot be used while someone acts as it', async () => {
    serveUsers(page([item(2, { role: 'MERCHANT' })], 1), [
      {
        id: 'imp-1',
        actor: { id: 'admin-2', fullName: 'Other Admin' },
        target: { id: 'user-2', fullName: 'User 2', role: 'MERCHANT' },
        startedAt: '2026-10-30T10:00:00.000Z',
        expiresAt: '2026-10-30T10:30:00.000Z',
        endedAt: null,
        endedReason: null,
        serverNow: '2026-10-30T10:05:00.000Z',
        writesEnabled: false,
      },
    ]);
    renderWithProviders(<UsersPanel currentUserId="admin-1" appUrls={APPS} />, 'ar');
    expect(await screen.findByRole('button', { name: 'الدخول بهذا الحساب (User 2)' })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'الدخول بهذا الحساب (User 2)' })
          .hasAttribute('disabled'),
      ).toBe(true),
    );
  });
});
