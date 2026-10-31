import { expect, test, type Page } from '@playwright/test';
import {
  accounts,
  apiAs,
  db,
  overflowsHorizontally,
  signInAdmin,
  URLS,
  watchCsp,
  zones,
} from './support';

/*
 * Phase 4C.5: a SUPER_ADMIN acts as a merchant and as a driver from the admin console, in the
 * isolated stack where impersonated writes are enabled (playwright.config.ts). Each journey
 * checks the hand-off, the banner, tab isolation, charge confirmation and blocked actions.
 */
test.describe.configure({ mode: 'serial' });

const REASON = 'Customer called support and asked for help';

/** Review screenshots, only when E2E_SCREENSHOT_DIR is set (never part of the assertions). */
async function snap(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test.afterAll(async () => {
  await db.$disconnect();
});

/**
 * Opens the start dialog, on the account's page or (with `fromListEmail`) from its row in the
 * users list, and returns the app tab it opens.
 */
async function startImpersonation(
  admin: Page,
  userId: string,
  fromListEmail?: string,
): Promise<Page> {
  let start;
  if (fromListEmail) {
    await admin.goto(`${URLS.admin}/users?q=${encodeURIComponent(fromListEmail)}`);
    await expect(admin.getByText('1 users')).toBeVisible();
    start = admin.getByRole('button', { name: /^Act as this account \(/ });
    await expect(start).toBeEnabled();
    await snap(admin, 'admin-users-list-row');
  } else {
    await admin.goto(`${URLS.admin}/users/${userId}`);
    start = admin.getByRole('button', { name: 'Act as this account' });
  }
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Reason').fill(REASON);
  await dialog.getByLabel('Your password').fill(accounts.admin.password);
  await snap(admin, `admin-start-dialog-${userId.slice(0, 8)}`);
  const [tab] = await Promise.all([
    admin.waitForEvent('popup'),
    dialog.getByRole('button', { name: 'Start session' }).click(),
  ]);
  await expect(tab.getByTestId('impersonation-banner')).toBeVisible({ timeout: 30_000 });
  await expect(admin.getByText(/You are now acting as/)).toBeVisible();
  return tab;
}

async function expectNoSecretsInTab(tab: Page) {
  // Nothing of the hand-off in the URL or in storage: only this tab's marker.
  expect(tab.url()).not.toMatch(/code|verifier|token/i);
  const stored = await tab.evaluate(() => ({
    session: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    local: Object.keys(localStorage),
  }));
  expect(stored.session).toEqual([['coobra.impersonation', 'active']]);
  expect(stored.local.filter((key) => !['coobra.language'].includes(key))).toEqual([]);
}

test('admin acts as the merchant: confirmed charges, a price change, blocked consent, end', async ({
  browser,
}) => {
  const admin = await signInAdmin(browser, 'admin');
  // The hand-off (window.open + postMessage) must work under the console's CSP.
  const csp = watchCsp(admin);
  // The admin's browser also has the merchant's own session open: it must survive untouched.
  const ownTab = await admin.context().newPage();
  await ownTab.goto(`${URLS.merchant}/login`);
  const email = ownTab.getByLabel('Email', { exact: true });
  const english = ownTab.getByRole('button', { name: 'English', exact: true });
  await expect(english.or(email).first()).toBeVisible();
  if (await english.isVisible()) await english.click();
  await email.fill(accounts.merchant.email);
  await ownTab.getByLabel('Password', { exact: true }).fill(accounts.merchant.password);
  await ownTab.getByRole('button', { name: 'Sign in' }).click();
  await ownTab.waitForURL(/\/home/);

  const tab = await startImpersonation(admin, accounts.merchant.id);
  await expect(tab.getByTestId('impersonation-banner')).toContainText(
    'Acting as E2E merchant (Merchant)',
  );
  await expect(tab.getByTestId('impersonation-banner')).toContainText('Administrator: E2E admin');
  await expect(tab.getByTestId('impersonation-remaining')).toHaveText(/^(30:00|29:\d\d)$/);
  await expect(tab.getByTestId('impersonation-view-only')).toHaveCount(0);
  await expectNoSecretsInTab(tab);
  // The console shows the active session too.
  await expect(admin.getByRole('region', { name: 'Your active impersonation' })).toBeVisible();
  await snap(admin, 'admin-active-bar');
  await snap(tab, 'merchant-banner-home');
  // Phone width: the banner (account, time left, End) stays on screen and nothing overflows.
  await tab.setViewportSize({ width: 390, height: 844 });
  await expect(tab.getByTestId('impersonation-banner')).toBeInViewport();
  await expect(tab.getByTestId('impersonation-remaining')).toBeVisible();
  expect(await overflowsHorizontally(tab)).toBe(false);
  await snap(tab, 'merchant-banner-phone');
  await tab.setViewportSize({ width: 1280, height: 720 });

  // Create a shipment: the charges are previewed by the server and confirmed.
  await tab.goto(`${URLS.merchant}/shipments/new`);
  await tab.getByLabel('Recipient name').fill('Impersonation Recipient');
  await tab.getByLabel('Recipient phone', { exact: true }).fill('0599123456');
  await tab.getByRole('button', { name: 'Delivery area' }).click();
  await tab.getByRole('button', { name: 'Ramallah & Al-Bireh' }).click();
  await tab.getByLabel('City / town').fill('Ramallah');
  await tab.getByLabel('Detailed address').fill('Main street 9');
  await tab.getByLabel('Cash on delivery (₪)').fill('80');
  await tab.getByRole('button', { name: 'Review charges' }).click();
  const sheet = tab.getByTestId('consequence-sheet');
  await expect(sheet.getByTestId('consequence-DELIVERY_FEE')).toContainText('15.00');
  await expect(sheet.getByTestId('consequence-COD_TO_COLLECT')).toContainText('80.00');
  await snap(tab, 'merchant-charges-sheet');

  // The price changes while the dialog is open: the server refuses the stale price, the form
  // explains it and fetches the new one, and the charges are reviewed again before creating.
  const ops = await apiAs('admin', 'ADMIN_WEB');
  const rule = await db.pricingRule.findFirstOrThrow({ where: { active: true } });
  const revised = await ops.post(`/v1/admin/pricing-rules/${rule.id}/revise`, {
    data: { deliveryFee: '18', returnFee: '10', note: 'E2E price change' },
  });
  expect(revised.status(), await revised.text()).toBe(201);
  try {
    await sheet.getByTestId('consequence-confirm').click();
    await expect(sheet).toHaveCount(0);
    await expect(
      tab.getByText(
        'The delivery price for this route changed. Check the new price and confirm again.',
      ),
    ).toBeVisible();
    await expect(tab.getByTestId('quote-fee')).toContainText('18.00');
    await snap(tab, 'merchant-price-changed');
    await tab.getByRole('button', { name: 'Review charges' }).click();
    await expect(sheet.getByTestId('consequence-DELIVERY_FEE')).toContainText('18.00');
    await sheet.getByTestId('consequence-confirm').click();
    await tab.waitForURL(/\/shipments\/[0-9a-f-]{36}/);
  } finally {
    // Put the price back for the other journeys.
    const current = await db.pricingRule.findFirstOrThrow({ where: { active: true } });
    await ops.post(`/v1/admin/pricing-rules/${current.id}/revise`, {
      data: { deliveryFee: '15', returnFee: '10', note: 'E2E price restored' },
    });
  }
  const shipmentId = tab.url().split('/shipments/')[1]!.split(/[?#]/)[0]!;
  const shipment = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  expect(shipment.deliveryFee?.toFixed(2)).toBe('18.00');
  expect(shipment.createdById).toBe(accounts.admin.id);
  expect(shipment.createdImpersonationId).not.toBeNull();

  // Financial consent stays the merchant's: visible, disabled, explained.
  await tab.goto(`${URLS.merchant}/finance`);
  const payout = tab.getByTestId('payout-submit');
  await expect(payout).toHaveAttribute('aria-disabled', 'true');
  await expect(tab.getByTestId('payout-submit-reason')).toHaveText(
    'Only the merchant can decide this. Use the admin console if needed.',
  );
  await snap(tab, 'merchant-blocked-payout');

  // A second tab of the same app in the same browser is the real session, not the impersonation.
  const other = await admin.context().newPage();
  await other.goto(`${URLS.merchant}/home`);
  await expect(other.getByText('Welcome')).toBeVisible();
  await expect(other.getByTestId('impersonation-banner')).toHaveCount(0);
  await other.close();

  // End from the banner: the tab shows "ended" and never falls back to a session.
  await tab.getByTestId('impersonation-end').click();
  await tab.getByTestId('impersonation-end-confirm').click();
  await expect(tab.getByText('Session ended')).toBeVisible();
  await tab.reload();
  await expect(tab.getByText('Session ended')).toBeVisible();
  await expect(tab.getByTestId('impersonation-banner')).toHaveCount(0);
  await snap(tab, 'merchant-ended');

  // The merchant's own session was never touched.
  await ownTab.reload();
  await expect(ownTab.getByText('Welcome')).toBeVisible();
  await expect(ownTab.getByTestId('impersonation-banner')).toHaveCount(0);

  // The audit log shows "admin acting as merchant" for that impersonation.
  const impersonation = await db.impersonationSession.findFirstOrThrow({
    where: { targetUserId: accounts.merchant.id },
    orderBy: { startedAt: 'desc' },
  });
  expect(impersonation.endedReason).toBe('MANUAL');
  await admin.goto(`${URLS.admin}/audit?impersonationId=${impersonation.id}`);
  await expect(admin.getByRole('button', { name: 'acting as E2E merchant' }).first()).toBeVisible();
  await snap(admin, 'admin-audit-acting-as');
  await ops.dispose();
  expect(csp).toEqual([]);
});

test('admin acts as the driver: reasons, a confirmed failure, blocked delivery, revocation', async ({
  browser,
}) => {
  // Set-up (not under test): a shipment assigned to the driver.
  const merchantApi = await apiAs('merchant', 'MERCHANT_APP');
  const created = await merchantApi.post('/v1/merchant/shipments', {
    data: {
      recipientName: 'Driver Journey',
      recipientPhone: '0599123456',
      destinationZoneId: zones.ramallah,
      city: 'Ramallah',
      addressLine: 'Main street 10',
      codAmount: '40',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const shipmentId = ((await created.json()) as { id: string }).id;
  const opsApi = await apiAs('ops', 'ADMIN_WEB');
  const assigned = await opsApi.post(`/v1/admin/shipments/${shipmentId}/assign`, {
    data: { driverId: accounts.driver.id },
  });
  expect(assigned.ok(), await assigned.text()).toBe(true);

  const admin = await signInAdmin(browser, 'admin');
  // This time from the users list row (the same dialog and hand-off).
  const tab = await startImpersonation(admin, accounts.driver.id, accounts.driver.email);
  await expectNoSecretsInTab(tab);
  await tab.goto(`${URLS.driver}/shipments/${shipmentId}`);

  // Every impersonated driver step needs a reason.
  for (const action of ['Mark picked up', 'Out for delivery']) {
    await tab.getByRole('button', { name: action }).click();
    await tab.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(tab.getByText('Please write a reason (at least 3 characters).')).toBeVisible();
    await tab.getByLabel('Reason').fill('Driver phone is broken');
    await tab.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(tab.getByRole('button', { name: action })).toHaveCount(0);
  }

  // Delivery posts money: shown, disabled, explained.
  const deliver = tab.getByRole('button', { name: 'Mark delivered' });
  await expect(deliver).toHaveAttribute('aria-disabled', 'true');
  await expect(
    tab.getByText('This posts money, so only the account holder can do it.'),
  ).toBeVisible();
  await snap(tab, 'driver-blocked-delivery');

  // A failed attempt has charges for the merchant later: previewed and confirmed.
  await tab.getByRole('button', { name: 'Delivery failed' }).click();
  await tab.getByLabel('Reason').fill('Recipient not at home');
  await tab.getByRole('button', { name: 'Review charges' }).click();
  const sheet = tab.getByTestId('consequence-sheet');
  await expect(sheet.getByTestId('consequence-validity')).toContainText('Valid for');
  await snap(tab, 'driver-charges-sheet');
  await sheet.getByTestId('consequence-confirm').click();
  await expect(sheet).toHaveCount(0);
  const failed = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  expect(failed.status).toBe('DELIVERY_FAILED');

  // Ended from the console: the tab notices on its next request and shows "ended".
  await admin.reload();
  await admin
    .getByRole('region', { name: 'Your active impersonation' })
    .getByRole('button', { name: 'End session' })
    .click();
  await expect(admin.getByRole('region', { name: 'Your active impersonation' })).toHaveCount(0);
  await tab.reload();
  await expect(tab.getByText('Session ended')).toBeVisible();
  await expect(tab.getByTestId('impersonation-banner')).toHaveCount(0);

  await merchantApi.dispose();
  await opsApi.dispose();
});

test('the hand-off page refuses to work without the admin console', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${URLS.merchant}/impersonate`);
  await expect(page.getByText('Open this page from the admin console.')).toBeVisible();
  // No session of any kind was created.
  expect(await page.evaluate(() => sessionStorage.getItem('coobra.impersonation'))).toBeNull();
  const cookies = await page.context().cookies();
  expect(cookies.map((cookie) => cookie.name)).not.toContain('coobra_imp_session');
});
