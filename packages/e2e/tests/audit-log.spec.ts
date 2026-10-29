import { expect, test } from '@playwright/test';
import { accounts, apiAs, db, signInAdmin, URLS } from './support';

test.afterAll(async () => {
  await db.$disconnect();
});

test('a super admin finds a change in the audit log; other staff cannot open it', async ({
  browser,
}) => {
  // Operations staff: no menu entry, no page, no API.
  const ops = await signInAdmin(browser, 'ops');
  await expect(ops.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await ops.goto(`${URLS.admin}/audit`);
  await expect(ops.getByText("You don't have permission to do that.")).toBeVisible();
  const opsApi = await apiAs('ops', 'ADMIN_WEB');
  expect((await opsApi.get('/v1/admin/audit-logs')).status()).toBe(403);
  await opsApi.dispose();

  // Set-up: the admin corrects the phone number of the operations account.
  const adminApi = await apiAs('admin', 'ADMIN_WEB');
  const user = await (await adminApi.get(`/v1/admin/users/${accounts.ops.id}`)).json();
  const edit = await adminApi.patch(`/v1/admin/users/${accounts.ops.id}`, {
    data: { phone: '0599777888', expectedUpdatedAt: user.updatedAt },
  });
  expect(edit.status(), await edit.text()).toBe(200);
  await adminApi.dispose();

  const admin = await signInAdmin(browser, 'admin');
  const before = await db.auditLog.count();
  await admin.getByRole('link', { name: 'Audit log' }).click();
  await admin.waitForURL(/\/audit/);
  await admin.getByLabel('Area').selectOption('USERS');
  await admin.getByLabel('Event').selectOption('USER_PROFILE_UPDATED');
  await admin.getByRole('button', { name: 'Apply' }).click();
  await admin.waitForURL(/action=USER_PROFILE_UPDATED/);
  await expect(admin.getByText('1 entries')).toBeVisible();

  // The entry shows who changed what, with the phone before and after.
  await admin.getByRole('button', { name: /^Details of Profile edited/ }).click();
  const dialog = admin.getByRole('dialog', { name: 'Profile edited' });
  const phone = dialog.getByRole('row', { name: /Phone/ });
  await expect(phone).toContainText('0599777888');
  await expect(dialog.getByText(/E2E admin · Super admin/)).toBeVisible();
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Searching by the person's email finds the entries about them (their sign-ins too).
  await admin.getByRole('button', { name: 'Clear filters' }).click();
  await admin.getByLabel('Search', { exact: true }).fill(accounts.ops.email);
  await admin.getByRole('button', { name: 'Apply' }).click();
  await expect(admin.getByRole('button', { name: /^Details of Signed in/ }).first()).toBeVisible();

  // Reading the log wrote nothing and changed nothing.
  expect(await db.auditLog.count()).toBe(before);
});
