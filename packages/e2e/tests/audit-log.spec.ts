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

  // Set-up: the admin corrects the phone number of the operations account (a new number each
  // run, so the test can be repeated against the same database).
  const phone = `0599${String(Date.now()).slice(-6)}`;
  const adminApi = await apiAs('admin', 'ADMIN_WEB');
  const user = await (await adminApi.get(`/v1/admin/users/${accounts.ops.id}`)).json();
  const edit = await adminApi.patch(`/v1/admin/users/${accounts.ops.id}`, {
    data: { phone, expectedUpdatedAt: user.updatedAt },
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
  const edits = await db.auditLog.count({ where: { action: 'USER_PROFILE_UPDATED' } });
  await expect(admin.getByText(`${edits} entries`)).toBeVisible();

  // The entry shows who changed what, with the phone before and after.
  // Newest first: the first entry is this edit.
  await admin
    .getByRole('button', { name: /^Details of Profile edited/ })
    .first()
    .click();
  const dialog = admin.getByRole('dialog', { name: 'Profile edited' });
  await expect(dialog.getByRole('row', { name: /Phone/ })).toContainText(phone);
  await expect(dialog.getByText(/E2E admin · Super admin/)).toBeVisible();
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Searching by the person's email finds the entries about them (their sign-ins too).
  // Clearing re-mounts the form from the URL; wait for that before typing, or the new search
  // lands in the old form and is discarded.
  const clear = admin.getByRole('button', { name: 'Clear filters' });
  await clear.click();
  await admin.waitForURL((url) => url.pathname.endsWith('/audit') && url.search === '');
  await expect(clear).toHaveCount(0);
  await expect(admin.getByLabel('Event')).toHaveValue('');
  const aboutOps = await db.auditLog.count({
    where: { OR: [{ actorUserId: accounts.ops.id }, { targetUserId: accounts.ops.id }] },
  });
  await admin.getByLabel('Search', { exact: true }).fill(accounts.ops.email);
  await admin.getByRole('button', { name: 'Apply' }).click();
  await admin.waitForURL(/[?&]q=/);
  await expect(admin.getByText(`${aboutOps} entries`)).toBeVisible();
  await expect(admin.getByRole('button', { name: /^Details of Signed in/ }).first()).toBeVisible();

  // Reading the log wrote nothing and changed nothing.
  expect(await db.auditLog.count()).toBe(before);
});
