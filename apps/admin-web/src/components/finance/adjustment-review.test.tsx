// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdjustmentItem, AdjustmentReview, ReviewEligibility } from '@coobra/shared';
import { bff, ClientApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { ReviewsTab } from './finance-panel';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bff: vi.fn(),
}));
const bffMock = vi.mocked(bff);
const FIRST_RENDER = { timeout: 5_000 };
const LIST = '/v1/admin/finance/adjustments';

const allowed: ReviewEligibility = { allowed: true, reason: null };
const refused = (reason: ReviewEligibility['reason']): ReviewEligibility => ({
  allowed: false,
  reason,
});
const review = (approve: ReviewEligibility, reject = approve): AdjustmentReview => ({
  approve,
  reject,
  checkedAt: '2026-10-31T10:00:00.000Z',
});

const adjustment = (overrides: Partial<AdjustmentItem> = {}): AdjustmentItem => ({
  id: 'adj-1',
  type: 'MERCHANT_CREDIT',
  merchant: { id: 'm-1', fullName: 'Jenin Sweets', businessName: 'Jenin Sweets' },
  amount: '40.00',
  reason: 'Damaged parcel refund',
  status: 'PENDING_APPROVAL',
  requestedBy: { id: 'acc-1', fullName: 'Lina Accountant' },
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: '2026-10-30T10:00:00.000Z',
  sourceType: 'UNLINKED',
  sourceShipment: null,
  sourceJournalEntryId: null,
  review: review(allowed),
  ...overrides,
});

function serve(items: AdjustmentItem[], decide?: () => Promise<unknown>) {
  bffMock.mockImplementation(async (path: string) => {
    if (path === LIST) return items;
    if (path.endsWith('/approve') && decide) return decide();
    if (path.startsWith('/v1/admin/finance/')) return [];
    throw new Error(`unexpected ${path}`);
  });
}

const renderTab = (language: 'en' | 'ar' = 'en') =>
  renderWithProviders(<ReviewsTab canDecide canPropose canSeeMoney />, language);

async function expectBlocked(message: string) {
  const reason = await screen.findByText(message, {}, FIRST_RENDER);
  for (const name of ['Approve', 'Reject']) {
    const button = screen.getByRole('button', { name });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  }
}

beforeEach(() => {
  bffMock.mockReset();
});

describe('Adjustment review', () => {
  it('disables both decisions on your own request, with the reason', async () => {
    serve([adjustment({ review: review(refused('OWN_REQUEST')) })]);
    renderTab();
    await expectBlocked(
      'You requested this adjustment, so another finance colleague must approve or reject it.',
    );
  });

  it('explains an amount above your approval limit', async () => {
    serve([adjustment({ amount: '500.00', review: review(refused('OVER_LIMIT')) })]);
    renderTab();
    await expectBlocked(
      'This amount is above your approval limit, so a super admin must decide it.',
    );
  });

  it('explains a conflict of interest (impersonation or involvement, UNLINKED included)', async () => {
    serve([adjustment({ review: review(refused('CONFLICT_OF_INTEREST')) })]);
    renderTab();
    await expectBlocked(
      'You were involved in what this adjustment corrects, or acted as this merchant, so an independent colleague must decide it.',
    );
  });

  it('fails closed when the eligibility is missing or could not be checked', async () => {
    serve([
      adjustment({ id: 'adj-1', review: undefined }),
      adjustment({ id: 'adj-2', review: null }),
      adjustment({ id: 'adj-3', review: review(refused('UNKNOWN')) }),
    ]);
    renderTab();
    const message =
      'Whether you can decide this could not be checked. Reload the page and try again.';
    expect(await screen.findAllByText(message, {}, FIRST_RENDER)).toHaveLength(3);
    for (const button of [
      ...screen.getAllByRole('button', { name: 'Approve' }),
      ...screen.getAllByRole('button', { name: 'Reject' }),
    ]) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });

  it('keeps approve and reject apart when their eligibility differs', async () => {
    serve([adjustment({ review: review(allowed, refused('OVER_LIMIT')) })]);
    renderTab();
    const reason = await screen.findByText(
      'This amount is above your approval limit, so a super admin must decide it.',
      {},
      FIRST_RENDER,
    );
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false);
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject.hasAttribute('disabled')).toBe(true);
    expect(reject.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('lets an eligible reviewer decide, shows a server refusal and reloads the list', async () => {
    serve([adjustment()], () =>
      Promise.reject(
        new ClientApiError({
          statusCode: 403,
          code: 'IMPERSONATION_CONFLICT',
          message: 'conflict',
        }),
      ),
    );
    const user = userEvent.setup();
    renderTab();
    const approve = await screen.findByRole('button', { name: 'Approve' }, FIRST_RENDER);
    expect(approve.hasAttribute('disabled')).toBe(false);
    await user.click(approve);
    const form = approve.ownerDocument.querySelector('form') as HTMLFormElement;
    const listCalls = () => bffMock.mock.calls.filter(([path]) => path === LIST).length;
    const before = listCalls();
    await user.click(within(form).getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(
        'You acted on this as the account holder, so another staff member must make this decision.',
      ),
    ).toBeTruthy();
    expect(bffMock).toHaveBeenCalledWith(
      '/v1/admin/finance/adjustments/adj-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
    // The eligibility shown was out of date: the list is fetched again.
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it('explains it in Arabic', async () => {
    serve([adjustment({ review: review(refused('CONFLICT_OF_INTEREST')) })]);
    renderTab('ar');
    expect(
      await screen.findByText(
        'كنت مشاركًا فيما تصحّحه هذه التسوية، أو دخلت بحساب هذا التاجر، لذلك يجب أن يقرّر فيها زميل مستقل.',
        {},
        FIRST_RENDER,
      ),
    ).toBeTruthy();
  });
});
