import { expect, test } from '@playwright/test';
import {
  accounts,
  apiAs,
  db,
  expectBalancedLedger,
  overflowsHorizontally,
  signInAdmin,
  URLS,
  watchCsp,
} from './support';

/*
 * Phase 4C.6 release smoke: a merchant adjustment reviewed in the console. The requester sees
 * the decision refused in advance with the reason (server eligibility, maker-checker); a second
 * accountant decides it in Arabic (right to left), also at phone width.
 */
test.afterAll(async () => {
  await db.$disconnect();
});

const REASON = 'E2E goodwill credit';

test('an adjustment is refused in advance to its requester and approved by a colleague', async ({
  browser,
}) => {
  const api = await apiAs('accountant', 'ADMIN_WEB');
  const requested = await api.post('/v1/admin/finance/adjustments', {
    data: {
      type: 'MERCHANT_CREDIT',
      merchantId: accounts.merchant.id,
      amount: '12',
      reason: REASON,
    },
  });
  expect(requested.status(), await requested.text()).toBe(201);
  const adjustmentId = ((await requested.json()) as { id: string }).id;
  await api.dispose();

  // The requester: both decisions disabled, with the reason linked to the buttons.
  const requester = await signInAdmin(browser, 'accountant');
  const csp = watchCsp(requester);
  const page = await requester.goto(`${URLS.admin}/finance`);
  // The console is served with its nonce-based CSP (so "no violations" below means something).
  const policy = page?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(policy).toContain("frame-ancestors 'none'");
  await requester.getByRole('tab', { name: 'Reviews' }).click();
  const own = requester.getByRole('listitem').filter({ hasText: REASON });
  const reason = own.getByText(
    'You requested this adjustment, so another finance colleague must approve or reject it.',
  );
  await expect(reason).toBeVisible();
  for (const name of ['Approve', 'Reject']) {
    const button = own.getByRole('button', { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-describedby', (await reason.getAttribute('id'))!);
  }

  // A colleague, in Arabic: right to left, and the decision is open to them.
  const colleague = await signInAdmin(browser, 'accountant2', 'ar');
  await expect(colleague.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(colleague.locator('html')).toHaveAttribute('lang', 'ar');
  await colleague.goto(`${URLS.admin}/finance`);
  await colleague.getByRole('tab', { name: 'مراجعات' }).click();
  const item = colleague.getByRole('listitem').filter({ hasText: REASON });
  const approve = item.getByRole('button', { name: 'اعتماد' });
  await expect(approve).toBeEnabled();

  // Phone width: the review still fits (no sideways page scroll).
  await colleague.setViewportSize({ width: 390, height: 844 });
  await expect(approve).toBeVisible();
  expect(await overflowsHorizontally(colleague)).toBe(false);

  await approve.click();
  await item.getByRole('button', { name: 'تأكيد' }).click();
  await expect
    .poll(
      async () =>
        (await db.financialAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } })).status,
    )
    .toBe('APPLIED');
  const decided = await db.financialAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
  expect(decided.decidedById).toBe(accounts.accountant2.id);
  await expectBalancedLedger();
  // The console runs under its CSP without a single violation.
  expect(csp).toEqual([]);
});

test('the users list fits a phone in Arabic and offers "Act as" per row', async ({ browser }) => {
  const admin = await signInAdmin(browser, 'admin', 'ar');
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`${URLS.admin}/users?q=${encodeURIComponent(accounts.merchant.email)}`);
  const start = admin.getByRole('button', { name: /^الدخول بهذا الحساب \(/ });
  await expect(start).toBeEnabled();
  // The table scrolls inside its own container; the page itself never scrolls sideways.
  expect(await overflowsHorizontally(admin)).toBe(false);
});
