import { expect, test } from '@playwright/test';
import {
  accounts,
  apiAs,
  balance,
  db,
  expectBalancedLedger,
  signInAdmin,
  signInMobile,
  URLS,
  zones,
} from './support';

// The journeys build on each other (the settlement needs the delivered cash).
test.describe.configure({ mode: 'serial' });

const confirm = 'Confirm';
let shipmentId = '';

test.afterAll(async () => {
  await db.$disconnect();
});

test('merchant creates, operations assign, driver delivers and collects the cash', async ({
  browser,
}) => {
  // Merchant app (own context): create a shipment priced from the approved pickup area.
  const merchant = await signInMobile(browser, 'merchant', 'merchant');
  await merchant.goto(`${URLS.merchant}/shipments/new`);
  await merchant.getByLabel('Recipient name').fill('E2E Recipient');
  await merchant.getByLabel('Recipient phone', { exact: true }).fill('٠٥٩٩١٢٣٤٥٦');
  await merchant.getByRole('button', { name: 'Delivery area' }).click();
  await merchant.getByRole('button', { name: 'Ramallah & Al-Bireh' }).click();
  await merchant.getByLabel('City / town').fill('Ramallah');
  await merchant.getByLabel('Detailed address').fill('Main street 1');
  await merchant.getByLabel('Cash on delivery (₪)').fill('120');
  const create = merchant.getByRole('button', { name: 'Create shipment' });
  await expect(create).toBeEnabled();
  await create.click();
  await merchant.waitForURL(/\/shipments\/[0-9a-f-]{36}/);
  shipmentId = merchant.url().split('/shipments/')[1]!.split(/[?#]/)[0]!;
  const shipment = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  expect(shipment.recipientPhone).toBe('0599123456');
  expect(shipment.deliveryFee?.toFixed(2)).toBe('15.00');

  // Admin (operations, own context): assign the driver.
  const ops = await signInAdmin(browser, 'ops');
  await ops.goto(`${URLS.admin}/shipments/${shipmentId}`);
  await ops.locator('#driverId').selectOption(accounts.driver.id);
  await ops.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(ops.getByText('Driver assigned.')).toBeVisible();

  // Driver app (own context): pick up, go out, deliver with the full cash collected.
  const driver = await signInMobile(browser, 'driver', 'driver');
  await driver.goto(`${URLS.driver}/shipments/${shipmentId}`);
  for (const action of ['Mark picked up', 'Out for delivery']) {
    await driver.getByRole('button', { name: action }).click();
    await driver.getByRole('button', { name: confirm, exact: true }).click();
    await expect(driver.getByRole('button', { name: action })).toHaveCount(0);
  }
  await driver.getByRole('button', { name: 'Mark delivered' }).click();
  await driver.getByRole('radio', { name: 'Yes, collected' }).click();
  await driver.getByLabel('Amount collected (₪)').fill('120');
  await driver
    .getByRole('checkbox', { name: 'I confirm I handed the shipment to the recipient.' })
    .click();
  await driver.getByRole('button', { name: 'Confirm delivery' }).click();
  await expect(driver.getByText('Delivered').first()).toBeVisible();

  expect((await db.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe(
    'DELIVERED',
  );
  expect(await balance(`DRIVER_CUSTODY:${accounts.driver.id}`)).toBe('120.00');
  expect(await balance(`MERCHANT_COD_PENDING:${accounts.merchant.id}`)).toBe('120.00');
  expect(await balance('DELIVERY_FEE_REVENUE')).toBe('15.00');
  await expectBalancedLedger();
});

test('driver hands over cash; only an accountant counts and confirms it', async ({ browser }) => {
  const driver = await signInMobile(browser, 'driver', 'driver');
  await driver.goto(`${URLS.driver}/finance`);
  await driver.getByLabel('Amount (₪)').fill('120');
  await driver.getByRole('button', { name: 'Hand over cash' }).click();
  await expect(driver.getByText('Sent. Waiting for the accountant to count it.')).toBeVisible();

  // Super admin and operations can see the hand-over but get no confirmation controls.
  for (const name of ['admin', 'ops'] as const) {
    const page = await signInAdmin(browser, name);
    await page.goto(`${URLS.admin}/finance`);
    await page.getByRole('tab', { name: 'Driver cash' }).click();
    await expect(page.getByText('Waiting to be counted').first()).toBeVisible();
    await expect(page.getByRole('button', { name: confirm, exact: true })).toHaveCount(0);
    // Debt repayments are posted by an accountant only.
    await expect(page.getByRole('button', { name: 'Record a driver repayment' })).toHaveCount(0);
  }

  // The accountant counts 100 of the declared 120.
  const accountant = await signInAdmin(browser, 'accountant');
  await accountant.goto(`${URLS.admin}/finance`);
  await accountant.getByRole('tab', { name: 'Driver cash' }).click();
  await expect(accountant.getByRole('button', { name: 'Record a driver repayment' })).toBeVisible();
  await accountant.getByRole('button', { name: confirm, exact: true }).click();
  await accountant.getByLabel('Counted').fill('100');
  await accountant.getByRole('button', { name: confirm, exact: true }).click();
  await expect(accountant.getByText('Difference')).toBeVisible();

  const settlement = await db.driverSettlement.findFirstOrThrow({
    where: { driverId: accounts.driver.id },
  });
  expect(settlement).toMatchObject({ status: 'CONFIRMED', decidedById: accounts.accountant.id });
  expect(settlement.countedAmount?.toFixed(2)).toBe('100.00');
  expect(await balance(`DRIVER_CUSTODY:${accounts.driver.id}`)).toBe('20.00');
  expect(await balance('COMPANY_CASH_HUB')).toBe('100.00');
  expect(await db.journalEntry.count({ where: { kind: 'DRIVER_SETTLEMENT' } })).toBe(1);
  await expectBalancedLedger();
});

test('a return is charged by the policy the shipment was priced with', async ({ browser }) => {
  // The accountant switches the route to "delivery fee + return fee" in the pricing screen.
  const accountant = await signInAdmin(browser, 'accountant');
  await accountant.goto(`${URLS.admin}/pricing`);
  await accountant.getByRole('button', { name: 'Change price' }).first().click();
  // The revision form's policy select (the create form has one too).
  await accountant
    .locator('select[id^="revise-"][name="returnPolicy"]')
    .selectOption('DELIVERY_PLUS_RETURN');
  await accountant.getByRole('button', { name: 'Save new version' }).click();
  await expect(accountant.locator('li').getByText('Delivery fee + return fee')).toBeVisible();

  // Set-up through the API: a new shipment whose delivery fails and comes back.
  const merchantApi = await apiAs('merchant', 'MERCHANT_APP');
  const opsApi = await apiAs('ops', 'ADMIN_WEB');
  const driverApi = await apiAs('driver', 'DRIVER_APP');
  const created = await merchantApi.post('/v1/merchant/shipments', {
    data: {
      recipientName: 'Return Recipient',
      recipientPhone: '0599123456',
      destinationZoneId: zones.ramallah,
      addressLine: 'Street 2',
      codAmount: '50',
    },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const move = async (api: typeof opsApi, base: string, toStatus: string, reason?: string) =>
    expect(
      (
        await api.post(`/v1/${base}/shipments/${id}/transitions`, {
          data: { toStatus, ...(reason ? { reason } : {}) },
        })
      ).status(),
    ).toBe(200);
  expect(
    (
      await opsApi.post(`/v1/admin/shipments/${id}/assign`, {
        data: { driverId: accounts.driver.id },
      })
    ).status(),
  ).toBe(200);
  await move(driverApi, 'driver', 'PICKED_UP');
  await move(driverApi, 'driver', 'OUT_FOR_DELIVERY');
  await move(driverApi, 'driver', 'DELIVERY_FAILED', 'Nobody home');
  await move(merchantApi, 'merchant', 'RETURN_REQUESTED', 'Customer cancelled');
  await move(opsApi, 'admin', 'RETURNED');

  await accountant.goto(`${URLS.admin}/shipments/${id}`);
  await expect(accountant.getByText('Total return charge')).toBeVisible();
  await expect(accountant.getByText('Delivery / attempt charge')).toBeVisible();

  const entry = await db.journalEntry.findFirstOrThrow({
    where: { kind: 'RETURN_FEE' },
    include: { lines: true },
  });
  const debitTotal = entry.lines
    .filter((line) => line.side === 'DEBIT')
    .reduce((sum, line) => sum + Number(line.amount), 0);
  expect(debitTotal).toBe(25);
  expect(await db.journalEntry.count({ where: { kind: 'DELIVERY_FEE' } })).toBe(1); // first journey
  await expectBalancedLedger();
  await Promise.all([merchantApi.dispose(), opsApi.dispose(), driverApi.dispose()]);
});

test('only an accountant posts a driver repayment, once per receipt', async ({ browser }) => {
  // Set-up: the driver owes 10 (a driver-liable cash shortage, approved by a second person).
  const accountantApi = await apiAs('accountant2', 'ADMIN_WEB');
  const adminApi = await apiAs('admin', 'ADMIN_WEB');
  const shortage = await accountantApi.post('/v1/admin/finance/driver-shortages', {
    data: {
      driverId: accounts.driver.id,
      amount: '10',
      responsibility: 'DRIVER_LIABLE',
      reason: 'E2E lost cash',
    },
  });
  expect(shortage.status()).toBe(201);
  const approved = await adminApi.post(
    `/v1/admin/finance/driver-shortages/${((await shortage.json()) as { id: string }).id}/approve`,
    { data: {}, headers: { 'idempotency-key': crypto.randomUUID() } },
  );
  expect(approved.status()).toBe(200);
  const debt = `DRIVER_RECEIVABLE:${accounts.driver.id}`;
  expect(await balance(debt)).toBe('10.00');

  // The super admin cannot post one through the API either (not only a hidden button).
  const forbidden = await adminApi.post('/v1/admin/finance/driver-repayments', {
    data: { driverId: accounts.driver.id, amount: '1', channel: 'HUB', receiptReference: 'RC-9' },
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(forbidden.status()).toBe(403);

  const repayInUi = async (name: 'accountant' | 'accountant2', receipt: string) => {
    const page = await signInAdmin(browser, name);
    await page.goto(`${URLS.admin}/finance`);
    await page.getByRole('tab', { name: 'Driver cash' }).click();
    await page.getByRole('button', { name: 'Record a driver repayment' }).click();
    await page.getByRole('combobox', { name: 'Driver' }).selectOption(accounts.driver.id);
    await page.getByLabel('Amount (₪)').fill('4');
    await page.getByLabel('Receipt / transfer number').fill(receipt);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    return page;
  };

  // First accountant posts receipt RC-1001 (typed with Arabic digits and lower case).
  const first = await repayInUi('accountant', 'rc-١٠٠١');
  await expect(first.getByRole('status')).toHaveText('Saved.');
  // A second accountant enters the same paper receipt: refused, nothing posted.
  const second = await repayInUi('accountant2', 'RC-1001');
  await expect(second.getByText('This payment reference was already used.')).toBeVisible();
  // A separate payment of the same amount with its own receipt is accepted.
  const third = await repayInUi('accountant2', 'RC-1002');
  await expect(third.getByRole('status')).toHaveText('Saved.');

  const repayments = await db.driverRepayment.findMany({
    where: { driverId: accounts.driver.id },
    orderBy: { createdAt: 'asc' },
  });
  expect(
    repayments.map((row) => [row.receiptReference, row.amount.toFixed(2), row.recordedById]),
  ).toEqual([
    ['RC-1001', '4.00', accounts.accountant.id],
    ['RC-1002', '4.00', accounts.accountant2.id],
  ]);
  expect(await db.journalEntry.count({ where: { kind: 'DRIVER_REPAYMENT' } })).toBe(2);
  expect(await balance(debt)).toBe('2.00');
  await expectBalancedLedger();
  await Promise.all([accountantApi.dispose(), adminApi.dispose()]);
});
