// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Paginated, UserListItem } from '@coobra/shared';
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

beforeEach(() => {
  bffMock.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('UsersPanel', () => {
  it('lists users with links to their details', async () => {
    bffMock.mockResolvedValue(
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
    bffMock.mockResolvedValue(page([item(1)], 1));
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
    bffMock.mockResolvedValue(page([item(21)], 45, 2));
    renderWithProviders(<UsersPanel />);
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith('/v1/admin/users?page=2&pageSize=20&role=DRIVER');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(replace).toHaveBeenCalledWith('/users?role=DRIVER&page=3');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(replace).toHaveBeenLastCalledWith('/users?role=DRIVER&page=1');
  });

  it('says when nothing matches', async () => {
    bffMock.mockResolvedValue(page([], 0));
    renderWithProviders(<UsersPanel />);
    expect(await screen.findByText('No users yet.')).toBeTruthy();
  });

  it('renders in Arabic', async () => {
    bffMock.mockResolvedValue(page([item(1, { status: 'DISABLED' })], 1));
    renderWithProviders(<UsersPanel />, 'ar');
    expect(await screen.findByRole('link', { name: 'فتح User 1' })).toBeTruthy();
    expect(screen.getAllByText('معطّل').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'بحث' })).toBeTruthy();
  });
});
