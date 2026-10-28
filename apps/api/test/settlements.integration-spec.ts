import request from 'supertest';
import type { Server as App } from 'node:http';
import type { DriverFinanceSummary, SettlementItem } from '@coobra/shared';
import {
  assertLedgerInvariants,
  createSignedInUser,
  createTestApp,
  ledgerBalance,
  resetDatabase,
  setupBasicPricing,
  type TestContext,
  type TestUser,
} from './helpers.js';

let keyCounter = 0;
const newKey = () => `settle-key-${Date.now()}-${++keyCounter}`;

describe('Driver settlements and cash shortages (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let accountant2: TestUser;
  let viewer: TestUser;
  let merchantA: TestUser;
  let merchantB: TestUser;
  let driver: TestUser;
  let driver2: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}, key?: string) => {
      const req = request(server()).post(path).set('authorization', `Bearer ${user.token}`);
      if (key) req.set('idempotency-key', key);
      return req.send(body);
    },
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    accountant2 = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc2@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    merchantA = await createSignedInUser(ctx, 'MERCHANT', 'a@example.com');
    merchantB = await createSignedInUser(ctx, 'MERCHANT', 'b@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    driver2 = await createSignedInUser(ctx, 'DRIVER', 'd2@example.com');
    zones = await setupBasicPricing(ctx.prisma, [merchantA.id, merchantB.id]);
  });

  afterEach(async () => {
    await assertLedgerInvariants(ctx.prisma);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  /** A delivered shipment with its full COD collected by `by` (fee 15). */
  async function delivered(merchant: TestUser, codAmount: string, by = driver) {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount,
      })
      .expect(201);
    const id = created.body.id as string;
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: by.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(by).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    await api(by)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: true, amount: codAmount, confirmed: true },
      })
      .expect(200);
    return id;
  }

  const balance = (code: string) => ledgerBalance(ctx.prisma, code);
  const submit = (amount: string, user = driver) =>
    api(user).post('/v1/driver/finance/settlements', { declaredAmount: amount }, newKey());
  const confirm = (id: string, body: object, user = accountant, key = newKey()) =>
    api(user).post(`/v1/admin/finance/settlements/${id}/confirm`, { channel: 'HUB', ...body }, key);

  it('confirms a full settlement and releases each merchant’s COD', async () => {
    await delivered(merchantA, '200');
    await delivered(merchantB, '300');
    const summary = (await api(driver).get('/v1/driver/finance').expect(200))
      .body as DriverFinanceSummary;
    expect(summary).toMatchObject({
      custody: '500.00',
      receivable: '0.00',
      pendingSettlement: null,
    });
    expect(summary.uncleared).toHaveLength(2);

    const settlement = (await submit('500').expect(201)).body as SettlementItem;
    expect(settlement).toMatchObject({
      status: 'SUBMITTED',
      declaredAmount: '500.00',
      submittedBy: { id: driver.id },
    });
    // Recording a collection is not cash received: nothing is available to merchants yet.
    expect(await balance(`MERCHANT_BALANCE:${merchantA.id}`)).toBe('-15.00');

    const confirmed = (await confirm(settlement.id, { countedAmount: '500' }).expect(200))
      .body as SettlementItem;
    expect(confirmed).toMatchObject({
      status: 'CONFIRMED',
      countedAmount: '500.00',
      decidedBy: { id: accountant.id },
    });
    expect(confirmed.clearings).toHaveLength(2);
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('0.00');
    expect(await balance('COMPANY_CASH_HUB')).toBe('500.00');
    expect(await balance(`MERCHANT_COD_PENDING:${merchantA.id}`)).toBe('0.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantA.id}`)).toBe('185.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantB.id}`)).toBe('285.00');
  });

  it('supports partial settlements (oldest first) and keeps the rest in custody', async () => {
    await delivered(merchantA, '200');
    await delivered(merchantB, '300');
    const first = (await submit('300').expect(201)).body as SettlementItem;
    // Declared 300, counted 280: 220 stays in custody, nothing is written off.
    await confirm(first.id, { countedAmount: '280' }).expect(200);
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('220.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantA.id}`)).toBe('185.00');
    expect(await balance(`MERCHANT_COD_PENDING:${merchantB.id}`)).toBe('220.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantB.id}`)).toBe('65.00');

    const second = (await submit('220').expect(201)).body as SettlementItem;
    await confirm(second.id, { countedAmount: '220' }).expect(200);
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('0.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantB.id}`)).toBe('285.00');
    expect(await balance('COMPANY_CASH_HUB')).toBe('500.00');
  });

  it('clears selected shipments first when the accountant chooses them', async () => {
    await delivered(merchantA, '200');
    const shipmentB = await delivered(merchantB, '300');
    const settlement = (await submit('300').expect(201)).body as SettlementItem;
    await confirm(settlement.id, { countedAmount: '300', shipmentIds: [shipmentB] }).expect(200);
    expect(await balance(`MERCHANT_BALANCE:${merchantB.id}`)).toBe('285.00');
    expect(await balance(`MERCHANT_COD_PENDING:${merchantA.id}`)).toBe('200.00');
  });

  it('prevents duplicate, excessive and concurrent settlements', async () => {
    await delivered(merchantA, '200');
    expect((await submit('250').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    const settlement = (await submit('200').expect(201)).body as SettlementItem;
    expect((await submit('50').expect(409)).body.code).toBe('INVALID_STATE');

    // Counted above declared is refused; the driver cannot confirm anything.
    await confirm(settlement.id, { countedAmount: '201' }).expect(400);
    await api(driver)
      .post(
        `/v1/admin/finance/settlements/${settlement.id}/confirm`,
        { countedAmount: '200' },
        newKey(),
      )
      .expect(403);
    await confirm(settlement.id, { countedAmount: '200' }, ops).expect(403);
    await confirm(settlement.id, { countedAmount: '200' }, viewer).expect(403);
    // SUPER_ADMIN monitors but does not count cash: no bypass through the normal endpoints.
    await confirm(settlement.id, { countedAmount: '200' }, admin).expect(403);
    await api(admin)
      .post(`/v1/admin/finance/settlements/${settlement.id}/reject`, { note: 'No' })
      .expect(403);
    await api(merchantA)
      .post(`/v1/admin/finance/settlements/${settlement.id}/reject`, { note: 'No' })
      .expect(403);
    expect(
      (
        await api(accountant)
          .post(`/v1/admin/finance/settlements/${settlement.id}/confirm`, { countedAmount: '200' })
          .expect(400)
      ).body.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = newKey();
    // Two accountants count the same hand-over at once: exactly one confirmation wins.
    const [a, b] = await Promise.all([
      confirm(settlement.id, { countedAmount: '200' }, accountant, key),
      confirm(settlement.id, { countedAmount: '200' }, accountant2),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // Replaying the accountant's request returns its stored outcome, never a second posting.
    if (a.status === 200) {
      expect(
        (await confirm(settlement.id, { countedAmount: '200' }, accountant, key).expect(200)).body
          .id,
      ).toBe(settlement.id);
    }
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'DRIVER_SETTLEMENT' } })).toBe(1);
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('0.00');
    // Nothing left to settle twice.
    expect((await submit('1').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
  });

  const record = (user: TestUser, declaredAmount: string, note?: string) =>
    api(user).post(
      '/v1/admin/finance/settlements',
      { driverId: driver.id, declaredAmount, ...(note ? { note } : {}) },
      newKey(),
    );

  it('lets operations register a counter hand-over that only an accountant counts', async () => {
    await delivered(merchantA, '200');
    await record(viewer, '100').expect(403);
    await record(merchantA, '100').expect(403);
    await record(driver2, '100').expect(403);
    const recorded = (await record(ops, '150', 'Counter').expect(201)).body as SettlementItem;
    expect(recorded).toMatchObject({
      status: 'SUBMITTED',
      submittedBy: { id: ops.id, role: 'OPERATIONS' },
      countedAmount: null,
      discrepancy: null,
    });
    // Registering is not receiving cash: nothing moves until the accountant counts it.
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('200.00');
    expect(await balance('COMPANY_CASH_HUB')).toBe('0.00');
    await confirm(recorded.id, { countedAmount: '150' }, ops).expect(403);
    const listed = await api(ops).get('/v1/admin/finance/settlements').expect(200);
    expect(listed.body.map((item: SettlementItem) => item.id)).toEqual([recorded.id]);
    // Operations do not see custody balances.
    await api(ops).get('/v1/admin/finance/drivers').expect(403);

    // Counted 140 of 150: 140 is cleared, the 10 discrepancy stays in the driver's custody.
    const confirmed = (await confirm(recorded.id, { countedAmount: '140' }).expect(200))
      .body as SettlementItem;
    expect(confirmed).toMatchObject({
      status: 'CONFIRMED',
      declaredAmount: '150.00',
      countedAmount: '140.00',
      discrepancy: '10.00',
      submittedBy: { id: ops.id },
      decidedBy: { id: accountant.id, role: 'ACCOUNTANT' },
    });
    expect(confirmed.decidedAt).toEqual(expect.any(String));
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('60.00');
    expect(await balance('COMPANY_CASH_HUB')).toBe('140.00');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'SETTLEMENT_CONFIRMED' },
    });
    expect(audit.actorUserId).toBe(accountant.id);
    expect(audit.metadata).toMatchObject({
      settlementId: recorded.id,
      submittedById: ops.id,
      declaredAmount: '150.00',
      countedAmount: '140.00',
      discrepancy: '10.00',
    });
    const submitted = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'SETTLEMENT_SUBMITTED' },
    });
    expect(submitted.metadata).toMatchObject({ submittedByRole: 'OPERATIONS' });
  });

  it('never lets an accountant decide a hand-over they registered', async () => {
    await delivered(merchantA, '200');
    const recorded = (await record(accountant, '150').expect(201)).body as SettlementItem;
    expect(
      (await confirm(recorded.id, { countedAmount: '150' }, accountant).expect(403)).body.code,
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      (
        await api(accountant)
          .post(`/v1/admin/finance/settlements/${recorded.id}/reject`, { note: 'Mine' })
          .expect(403)
      ).body.code,
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    await api(accountant2)
      .post(`/v1/admin/finance/settlements/${recorded.id}/reject`, {})
      .expect(400);
    const rejected = await api(accountant2)
      .post(`/v1/admin/finance/settlements/${recorded.id}/reject`, { note: 'Wrong driver' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decidedBy: { id: accountant2.id } });
    // Decided once: a later confirmation is refused and nothing is posted.
    await confirm(recorded.id, { countedAmount: '150' }, accountant2).expect(409);
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('200.00');
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'DRIVER_SETTLEMENT' } })).toBe(0);
    await submit('200').expect(201);
  });

  it('keeps driver finance private', async () => {
    await delivered(merchantA, '200');
    await delivered(merchantB, '50', driver2);
    const mine = (await api(driver2).get('/v1/driver/finance').expect(200))
      .body as DriverFinanceSummary;
    expect(mine.custody).toBe('50.00');
    expect(mine.uncleared).toHaveLength(1);
    await api(driver2).get('/v1/admin/finance/drivers').expect(403);
    await api(merchantA).get('/v1/driver/finance').expect(403);
    const all = await api(viewer).get('/v1/admin/finance/drivers').expect(200);
    expect(all.body.map((row: { custody: string }) => row.custody)).toEqual(['200.00', '50.00']);
  });

  it('handles driver cash shortages with approval, never charging the merchant', async () => {
    await delivered(merchantA, '200');
    const proposeBody = {
      driverId: driver.id,
      amount: '100',
      responsibility: 'DRIVER_LIABLE',
      reason: 'Lost 100 ILS',
    };
    await api(ops).post('/v1/admin/finance/driver-shortages', proposeBody).expect(403);
    // Recording a cash discrepancy is the accountant's job, not the super admin's.
    await api(admin).post('/v1/admin/finance/driver-shortages', proposeBody).expect(403);
    await api(accountant)
      .post('/v1/admin/finance/driver-shortages', { ...proposeBody, amount: '300' })
      .expect(422);
    const proposed = await api(accountant)
      .post('/v1/admin/finance/driver-shortages', proposeBody)
      .expect(201);
    const path = `/v1/admin/finance/driver-shortages/${proposed.body.id}/approve`;
    expect((await api(accountant).post(path, {}, newKey()).expect(403)).body.code).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    await api(admin).post(path, {}, newKey()).expect(200);

    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('100.00');
    expect(await balance(`DRIVER_RECEIVABLE:${driver.id}`)).toBe('100.00');
    // The recipient paid: the merchant gets the 100 even though the driver lost it.
    expect(await balance(`MERCHANT_BALANCE:${merchantA.id}`)).toBe('85.00');
    expect(await balance(`MERCHANT_COD_PENDING:${merchantA.id}`)).toBe('100.00');

    const repay = (amount: string) =>
      api(accountant).post(
        '/v1/admin/finance/driver-repayments',
        { driverId: driver.id, amount, channel: 'HUB' },
        newKey(),
      );
    await repay('60').expect(201);
    expect((await repay('50').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(`DRIVER_RECEIVABLE:${driver.id}`)).toBe('40.00');
    expect(await balance('COMPANY_CASH_HUB')).toBe('60.00');

    const absorbed = await api(accountant2)
      .post('/v1/admin/finance/driver-shortages', {
        driverId: driver.id,
        amount: '100',
        responsibility: 'COMPANY_ABSORBS',
        reason: 'Robbery, police report',
      })
      .expect(201);
    await api(accountant)
      .post(`/v1/admin/finance/driver-shortages/${absorbed.body.id}/approve`, {}, newKey())
      .expect(200);
    expect(await balance('DRIVER_CASH_LOSS_EXPENSE')).toBe('100.00');
    expect(await balance(`DRIVER_CUSTODY:${driver.id}`)).toBe('0.00');
    expect(await balance(`MERCHANT_BALANCE:${merchantA.id}`)).toBe('185.00');
  });

  it('lets only an accountant post a driver debt repayment, once and never above the debt', async () => {
    await delivered(merchantA, '200');
    const shortage = await api(accountant)
      .post('/v1/admin/finance/driver-shortages', {
        driverId: driver.id,
        amount: '100',
        responsibility: 'DRIVER_LIABLE',
        reason: 'Lost 100 ILS',
      })
      .expect(201);
    await api(admin)
      .post(`/v1/admin/finance/driver-shortages/${shortage.body.id}/approve`, {}, newKey())
      .expect(200);
    const debt = `DRIVER_RECEIVABLE:${driver.id}`;
    expect(await balance(debt)).toBe('100.00');
    const repay = (user: TestUser, amount: string, key = newKey()) =>
      api(user).post(
        '/v1/admin/finance/driver-repayments',
        { driverId: driver.id, amount, channel: 'HUB' },
        key,
      );

    // Nobody but an accountant can post it, whatever the role.
    for (const user of [admin, ops, viewer, driver, merchantA]) {
      await repay(user, '10').expect(403);
    }
    expect(await balance(debt)).toBe('100.00');
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'DRIVER_REPAYMENT' } })).toBe(0);

    // A retried request (same Idempotency-Key) returns the first result: one posting.
    const key = newKey();
    const first = await repay(accountant, '30', key).expect(201);
    const replay = await repay(accountant, '30', key).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'DRIVER_REPAYMENT' } })).toBe(1);
    expect(await balance(debt)).toBe('70.00');

    // Two accountants post 60 each against the remaining 70 at once: only one succeeds.
    const [a, b] = await Promise.all([repay(accountant, '60'), repay(accountant2, '60')]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await balance(debt)).toBe('10.00');
    expect((await repay(accountant, '10.01').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    // Zero amounts are refused as invalid input (they used to fail with a server error).
    expect((await repay(accountant, '0').expect(400)).body.fieldErrors).toEqual({
      amount: 'validation.money.invalid',
    });
    await api(accountant)
      .post('/v1/admin/finance/driver-shortages', {
        driverId: driver.id,
        amount: '0',
        responsibility: 'DRIVER_LIABLE',
        reason: 'Nothing',
      })
      .expect(400);

    const row = await ctx.prisma.driverRepayment.findUniqueOrThrow({
      where: { id: first.body.id },
    });
    const entry = await ctx.prisma.journalEntry.findUniqueOrThrow({
      where: { id: row.journalEntryId },
    });
    expect(row).toMatchObject({ driverId: driver.id, recordedById: accountant.id });
    expect(row.amount.toFixed(2)).toBe('30.00');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(entry).toMatchObject({ kind: 'DRIVER_REPAYMENT', createdById: accountant.id });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'DRIVER_REPAYMENT_RECORDED', actorUserId: accountant.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.metadata).toMatchObject({
      repaymentId: first.body.id,
      journalEntryId: row.journalEntryId,
      debtAccount: debt,
      amount: '30.00',
      outstandingBefore: '100.00',
      outstandingAfter: '70.00',
    });
    expect(await balance('COMPANY_CASH_HUB')).toBe('90.00');
  });
});
