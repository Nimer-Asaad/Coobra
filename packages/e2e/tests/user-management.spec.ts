import { expect, test } from '@playwright/test';
import { accounts, apiAs, db, signInAdmin, submitAdminLogin, URLS } from './support';

test.afterAll(async () => {
  await db.$disconnect();
});

test('a super admin deactivates a user, who is signed out until reactivated', async ({
  browser,
}) => {
  // Other roles cannot reach user management, not even through the API.
  const opsApi = await apiAs('ops', 'ADMIN_WEB');
  expect((await opsApi.get('/v1/admin/users')).status()).toBe(403);
  await opsApi.dispose();

  // The viewer is signed in (own browser context) while the admin works.
  const viewer = await signInAdmin(browser, 'viewer');

  const admin = await signInAdmin(browser, 'admin');
  await admin.goto(`${URLS.admin}/users`);
  await admin.getByLabel('Search by name, email, phone or business').fill(accounts.viewer.email);
  await admin.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(admin.getByText('1 users')).toBeVisible();
  await admin.getByRole('link', { name: /^Open / }).click();
  await admin.waitForURL(/\/users\/[0-9a-f-]{36}/);

  await admin.getByRole('button', { name: 'Deactivate account' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/Reason/).fill('E2E: left the company');
  await dialog.getByRole('button', { name: 'Deactivate account' }).click();
  await expect(admin.getByRole('status')).toHaveText(
    'Account deactivated. The user has been signed out.',
  );

  // The viewer's session is gone and the account cannot sign in.
  await viewer.goto(`${URLS.admin}/dashboard`);
  await viewer.waitForURL(/\/login/);
  expect(await submitAdminLogin(viewer, 'viewer')).toBe(403);
  await expect(viewer.getByText('This account has been disabled. Contact support.')).toBeVisible();

  // Reactivated: the same password works again.
  await admin.getByRole('button', { name: 'Reactivate account' }).click();
  await admin
    .getByRole('dialog')
    .getByLabel(/Reason/)
    .fill('E2E: rehired');
  await admin.getByRole('dialog').getByRole('button', { name: 'Reactivate account' }).click();
  await expect(admin.getByRole('status')).toHaveText('Account reactivated.');
  expect(await submitAdminLogin(viewer, 'viewer')).toBe(200);
  await viewer.waitForURL(/\/dashboard/);

  // Both changes are in the audit log and shown in the account history.
  await admin.reload();
  await expect(admin.getByText('E2E: left the company')).toBeVisible();
  await expect(admin.getByText('E2E: rehired')).toBeVisible();
  const logs = await db.auditLog.findMany({
    where: {
      targetUserId: accounts.viewer.id,
      action: { in: ['USER_DEACTIVATED', 'USER_REACTIVATED'] },
    },
    orderBy: { createdAt: 'asc' },
  });
  expect(logs.map((log) => [log.action, log.actorUserId])).toEqual([
    ['USER_DEACTIVATED', accounts.admin.id],
    ['USER_REACTIVATED', accounts.admin.id],
  ]);

  // The admin's own account offers no way to lock themself out.
  await admin.goto(`${URLS.admin}/users/${accounts.admin.id}`);
  await expect(admin.getByText(/This is your own account/)).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Deactivate account' })).toHaveCount(0);
});
