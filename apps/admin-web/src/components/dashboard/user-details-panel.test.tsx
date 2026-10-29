// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDetails } from '@coobra/shared';
import { bff, ClientApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { UserDetailsPanel } from './user-details-panel';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(),
}));
const bffMock = vi.mocked(bff);

const details = (overrides: Partial<UserDetails> = {}): UserDetails => ({
  id: 'user-1',
  email: 'ops@example.com',
  fullName: 'Omar Ops',
  phone: '0599000001',
  role: 'OPERATIONS',
  status: 'ACTIVE',
  language: 'en',
  emailVerified: true,
  merchant: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  createdBy: { id: 'admin-1', fullName: 'Sara Admin' },
  lastSignInAt: '2026-10-28T09:00:00.000Z',
  activeSessions: 2,
  history: [
    {
      id: 'log-1',
      action: 'USER_ROLE_CHANGED',
      actor: { id: 'admin-1', fullName: 'Sara Admin' },
      createdAt: '2026-10-02T10:00:00.000Z',
      metadata: { from: 'ACCOUNTANT', to: 'OPERATIONS', reason: 'Moved to the warehouse team' },
    },
  ],
  ...overrides,
});

/** Serves `user` for reads; a change goes to `after`, and what it returns is read from then on. */
function respond(user: UserDetails, after?: (path: string, init?: unknown) => unknown) {
  let current = user;
  bffMock.mockImplementation(async (path: string, init?: unknown) => {
    if (init && after) {
      const next = (await after(path, init)) as UserDetails | undefined;
      if (next) current = next;
      return next;
    }
    return current;
  });
}

beforeEach(() => bffMock.mockReset());

describe('UserDetailsPanel', () => {
  it('shows the account details and history', async () => {
    respond(details());
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    expect(await screen.findByRole('heading', { name: 'Omar Ops' })).toBeTruthy();
    expect(screen.getByText('Signed-in sessions')).toBeTruthy();
    expect(
      screen.getByText('Role changed · Accountant → Operations', { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText('Moved to the warehouse team')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change role' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deactivate account' })).toBeTruthy();
  });

  it('hides deactivation and role changes on your own account', async () => {
    respond(details({ id: 'admin-1', role: 'SUPER_ADMIN' }));
    renderWithProviders(<UserDetailsPanel id="admin-1" currentUserId="admin-1" />);
    expect(await screen.findByText(/This is your own account/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Deactivate account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change role' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy();
  });

  it('keeps the role of drivers and merchants', async () => {
    respond(details({ role: 'DRIVER' }));
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    expect(await screen.findByText(/Drivers and merchants keep their role/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change role' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate account' })).toBeTruthy();
  });

  it('asks for a reason before deactivating and sends the version it saw', async () => {
    const user = userEvent.setup();
    const deactivate = vi.fn<(path: string, init: unknown) => UserDetails>(() =>
      details({ status: 'DISABLED', activeSessions: 0 }),
    );
    respond(details(), (path, init) => deactivate(path, init));
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Deactivate account' }));

    const dialog = screen.getByRole('dialog', { name: 'Deactivate Omar Ops?' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    expect(within(dialog).getByText('Please write a reason (at least 3 characters).')).toBeTruthy();
    expect(deactivate).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Reason/), 'Left the company');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deactivate).toHaveBeenCalledWith('/v1/admin/users/user-1/deactivate', {
      method: 'POST',
      body: { reason: 'Left the company', expectedUpdatedAt: '2026-10-02T10:00:00.000Z' },
    });
    expect(screen.getByText('Account deactivated. The user has been signed out.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reactivate account' })).toBeTruthy();
  });

  it('closes the confirmation with Cancel or Escape without changing anything', async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    respond(details(), change);
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Change role' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Change role' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it('changes the role among staff roles only', async () => {
    const user = userEvent.setup();
    const change = vi.fn<(path: string, init: unknown) => UserDetails>(() =>
      details({ role: 'ACCOUNTANT' }),
    );
    respond(details(), (path, init) => change(path, init));
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Change role' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the role of Omar Ops' });
    const options = within(dialog)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Super admin', 'Accountant', 'Owner (view only)']);
    await user.selectOptions(within(dialog).getByLabelText('New role'), 'ACCOUNTANT');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Joins finance');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(screen.getByText('Role changed. The user has been signed out.')).toBeTruthy(),
    );
    expect(change).toHaveBeenCalledWith('/v1/admin/users/user-1/role', {
      method: 'POST',
      body: {
        role: 'ACCOUNTANT',
        reason: 'Joins finance',
        expectedUpdatedAt: '2026-10-02T10:00:00.000Z',
      },
    });
  });

  it('shows the last super admin refusal inside the dialog', async () => {
    const user = userEvent.setup();
    respond(details({ role: 'SUPER_ADMIN' }), () => {
      throw new ClientApiError({
        statusCode: 409,
        code: 'LAST_SUPER_ADMIN',
        message: 'Last super admin',
      });
    });
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Deactivate account' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Cleanup');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate account' }));
    expect(await within(dialog).findByText(/last active super admin/)).toBeTruthy();
  });

  it('reloads the user when someone else changed it first', async () => {
    const user = userEvent.setup();
    respond(details(), () => {
      throw new ClientApiError({ statusCode: 409, code: 'USER_CHANGED', message: 'Changed' });
    });
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Omar Ops' });
    await user.clear(within(dialog).getByLabelText('Full name'));
    await user.type(within(dialog).getByLabelText('Full name'), 'Omar Operations');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/Someone else changed this user/)).toBeTruthy();
    // The initial load plus the reload after the conflict.
    await waitFor(() => expect(bffMock.mock.calls.filter(([, init]) => !init)).toHaveLength(2));
  });

  it('edits the business name of a merchant', async () => {
    const user = userEvent.setup();
    const edit = vi.fn<(path: string, init: unknown) => UserDetails>(() =>
      details({ role: 'MERCHANT', merchant: { businessName: 'New Shop' } }),
    );
    respond(details({ role: 'MERCHANT', merchant: { businessName: 'Old Shop' } }), (path, init) =>
      edit(path, init),
    );
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const field = screen.getByLabelText('Business name');
    await user.clear(field);
    await user.type(field, 'New Shop');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Changes saved.')).toBeTruthy());
    expect(edit).toHaveBeenCalledWith('/v1/admin/users/user-1', {
      method: 'PATCH',
      body: expect.objectContaining({ businessName: 'New Shop', fullName: 'Omar Ops' }),
    });
  });

  it('renders in Arabic', async () => {
    respond(details());
    renderWithProviders(<UserDetailsPanel id="user-1" currentUserId="admin-1" />, 'ar');
    expect(await screen.findByText('تفاصيل الحساب')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تعطيل الحساب' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تغيير الدور' })).toBeTruthy();
    expect(screen.getByText('تغييرات الحساب')).toBeTruthy();
  });
});
