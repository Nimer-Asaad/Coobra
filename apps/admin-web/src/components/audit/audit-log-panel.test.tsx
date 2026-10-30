// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogDetails, AuditLogListItem, Paginated } from '@coobra/shared';
import { navItemsFor } from '@/components/dashboard/nav';
import { bff, ClientApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { AuditLogPanel } from './audit-log-panel';

// The filters render one <option> per audit action, so a role query scans a large tree. Under a
// parallel test run the first lookup already took 1.4–1.6 s on main (the default wait is 1 s).
const FIRST_RENDER = { timeout: 5_000 };

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/audit',
  useSearchParams: () => search,
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(),
}));
const bffMock = vi.mocked(bff);

const SHIPMENT = '0199a1c2-7d3e-7f00-8000-0000000000aa';
const entry = (overrides: Partial<AuditLogListItem> = {}): AuditLogListItem => ({
  id: '0199a1c2-7d3e-7f00-8000-000000000001',
  action: 'SHIPMENT_STATUS_CHANGED',
  category: 'SHIPMENTS',
  createdAt: '2026-10-01T08:00:00.000Z',
  actor: { id: 'ops-1', fullName: 'Sami Ops', role: 'OPERATIONS' },
  targetUser: { id: 'm-1', fullName: 'Jenin Sweets', role: 'MERCHANT' },
  entity: { type: 'SHIPMENT', id: SHIPMENT },
  summary: 'CB-12345678',
  ...overrides,
});
const details: AuditLogDetails = {
  ...entry({
    id: '0199a1c2-7d3e-7f00-8000-000000000002',
    action: 'USER_PROFILE_UPDATED',
    category: 'USERS',
    entity: { type: 'USER', id: 'ops-1' },
    summary: 'Name fix',
  }),
  ipAddress: '203.0.113.7',
  userAgent: 'Test agent',
  changes: [
    { field: 'fullName', before: 'Sami', after: 'Sami Ops' },
    { field: 'role', before: 'ACCOUNTANT', after: 'OPERATIONS' },
  ],
  details: { reason: 'Name fix', note: '[redacted]' },
  redacted: ['note'],
};
const page = (
  items: AuditLogListItem[],
  total = items.length,
  n = 1,
): Paginated<AuditLogListItem> => ({
  items,
  total,
  page: n,
  pageSize: 25,
});

function serve(list: Paginated<AuditLogListItem> | (() => never)) {
  bffMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/v1/admin/audit-logs?')) return typeof list === 'function' ? list() : list;
    if (path === `/v1/admin/audit-logs/${details.id}`) return details;
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  bffMock.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('AuditLogPanel', () => {
  it('is in the navigation for super admins only', () => {
    expect(navItemsFor('SUPER_ADMIN').map((item) => item.href)).toContain('/audit');
    for (const role of ['ACCOUNTANT', 'OPERATIONS', 'OWNER_VIEWER'] as const) {
      expect(navItemsFor(role).map((item) => item.href)).not.toContain('/audit');
    }
  });

  it('lists entries with actor, target, record and summary', async () => {
    serve(page([entry()], 1));
    renderWithProviders(<AuditLogPanel />);
    expect(
      await screen.findByRole(
        'button',
        { name: /Details of Shipment status changed/ },
        FIRST_RENDER,
      ),
    );
    expect(screen.getByText('Sami Ops')).toBeTruthy();
    expect(screen.getByText('Jenin Sweets')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shipment' })).toBeTruthy();
    expect(screen.getByText('CB-12345678')).toBeTruthy();
    expect(screen.getByText('1 entries')).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith('/v1/admin/audit-logs?page=1&pageSize=25');
  });

  it('applies search, area, event, record and date filters through the URL', async () => {
    const user = userEvent.setup();
    serve(page([entry()]));
    renderWithProviders(<AuditLogPanel />);
    await screen.findByText('Sami Ops');
    await user.type(screen.getByLabelText('Search'), 'CB-12345678');
    await user.selectOptions(screen.getByLabelText('Area'), 'FINANCE');
    // The event list follows the chosen area.
    const events = within(screen.getByLabelText('Event')).getAllByRole('option');
    expect(events.map((option) => option.textContent)).toContain('Cash handover confirmed');
    expect(events.map((option) => option.textContent)).not.toContain('Signed in');
    await user.selectOptions(screen.getByLabelText('Event'), 'SETTLEMENT_CONFIRMED');
    await user.selectOptions(screen.getByLabelText('Record type'), 'SETTLEMENT');
    await user.type(screen.getByLabelText('Record id'), 'abc');
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-03');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(replace).toHaveBeenCalledWith(
      '/audit?q=CB-12345678&category=FINANCE&action=SETTLEMENT_CONFIRMED&entityType=SETTLEMENT&entityId=abc&from=2026-10-01&to=2026-10-03',
    );
  });

  it('sends the date range as local day boundaries and refuses an inverted range', async () => {
    const user = userEvent.setup();
    search = new URLSearchParams('from=2026-10-01&to=2026-10-03');
    serve(page([entry()]));
    renderWithProviders(<AuditLogPanel />);
    await screen.findByText('Sami Ops');
    const path = bffMock.mock.calls[0]![0] as string;
    const sent = new URLSearchParams(path.split('?')[1]);
    expect(sent.get('from')).toBe(new Date('2026-10-01T00:00:00').toISOString());
    expect(sent.get('to')).toBe(new Date('2026-10-04T00:00:00').toISOString());

    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-10-09');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('The end date must be after the start date.')).toBeTruthy();
    expect(screen.getByLabelText('To').getAttribute('aria-invalid')).toBe('true');
    expect(replace).not.toHaveBeenCalled();
  });

  it('filters by a person or a record from the table, and shows the person filter', async () => {
    const user = userEvent.setup();
    serve(page([entry()]));
    const view = renderWithProviders(<AuditLogPanel />);
    await user.click(await screen.findByRole('button', { name: 'Sami Ops' }, FIRST_RENDER));
    expect(replace).toHaveBeenLastCalledWith('/audit?actorId=ops-1');
    await user.click(screen.getByRole('button', { name: 'Shipment' }));
    expect(replace).toHaveBeenLastCalledWith(`/audit?entityType=SHIPMENT&entityId=${SHIPMENT}`);

    view.unmount();
    search = new URLSearchParams('actorId=ops-1');
    renderWithProviders(<AuditLogPanel />);
    await user.click(await screen.findByRole('button', { name: 'Stop filtering by Sami Ops' }));
    expect(replace).toHaveBeenLastCalledWith('/audit');
  });

  it('pages through results', async () => {
    const user = userEvent.setup();
    search = new URLSearchParams('category=USERS&page=2');
    serve(page([entry()], 60, 2));
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith('/v1/admin/audit-logs?page=2&pageSize=25&category=USERS');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(replace).toHaveBeenLastCalledWith('/audit?category=USERS&page=3');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(replace).toHaveBeenLastCalledWith('/audit?category=USERS&page=1');
  });

  it('tells an empty log from a search without results', async () => {
    serve(page([]));
    const view = renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText('No audit entries yet.')).toBeTruthy();
    view.unmount();
    search = new URLSearchParams('q=nothing');
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText('No entries match these filters.')).toBeTruthy();
  });

  it('shows the error and retries', async () => {
    const user = userEvent.setup();
    let fail = true;
    bffMock.mockImplementation(async () => {
      if (fail) throw new ClientApiError({ statusCode: 403, code: 'FORBIDDEN', message: 'No' });
      return page([entry()]);
    });
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText("You don't have permission to do that.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sami Ops')).toBeTruthy();
  });

  it('opens an entry with its changes, withheld fields and request details; Escape closes it', async () => {
    const user = userEvent.setup();
    serve(page([entry({ id: details.id, action: 'USER_PROFILE_UPDATED', category: 'USERS' })]));
    renderWithProviders(<AuditLogPanel />);
    const opener = await screen.findByRole(
      'button',
      { name: /Details of Profile edited/ },
      FIRST_RENDER,
    );
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Profile edited' });
    await within(dialog).findByText('Changes');
    const fullName = within(dialog).getByRole('rowheader', { name: 'Full name' }).closest('tr')!;
    expect(within(fullName).getByText('Sami')).toBeTruthy();
    expect(within(fullName).getByText('Sami Ops')).toBeTruthy();
    // Roles are translated, withheld values say so without content.
    expect(within(dialog).getByText('Accountant')).toBeTruthy();
    expect(within(dialog).getByText('withheld')).toBeTruthy();
    expect(within(dialog).getByText(/Some fields are withheld.*note/)).toBeTruthy();
    expect(within(dialog).getByText('203.0.113.7')).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('renders in Arabic', async () => {
    serve(page([entry()]));
    renderWithProviders(<AuditLogPanel />, 'ar');
    expect(await screen.findByRole('heading', { name: 'سجل التدقيق' }, FIRST_RENDER)).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /تفاصيل تغيير حالة الشحنة/ }, FIRST_RENDER),
    ).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('الشحنات')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تطبيق' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'شحنة' })).toBeTruthy();
  });
});
