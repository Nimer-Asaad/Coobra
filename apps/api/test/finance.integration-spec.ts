import request from 'supertest';
import type { Server as App } from 'node:http';
import type { CodShortfallItem, ShipmentDetails } from '@coobra/shared';
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
const newKey = () => `test-key-${Date.now()}-${++keyCounter}`;

describe('COD accounting, shortfalls and adjustments (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let merchant: TestUser;
  let otherMerchant: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}, key?: string) => {
      const req = request(server()).post(path).set('authorization', `Bearer ${user.token}`);
      if (key) req.set('idempotency-key', key);
      return req.send(body);
    },
    put: (path: string, body: object = {}) =>
      request(server()).put(path).set('authorization', `Bearer ${user.token}`).send(body),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'm@example.com');
    otherMerchant = await createSignedInUser(ctx, 'MERCHANT', 'm2@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    zones = await setupBasicPricing(ctx.prisma, [merchant.id, otherMerchant.id]);
  });

  afterEach(async () => {
    await assertLedgerInvariants(ctx.prisma);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  /** Creates a shipment (fee 15) and takes it out for delivery. */
  async function outForDelivery(codAmount = '200') {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Ahmad Khalil',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Main street',
        codAmount,
      })
      .expect(201);
    const id = created.body.id as string;
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    return id;
  }

  const deliver = (id: string, cod: object) =>
    api(driver).post(`/v1/driver/shipments/${id}/transitions`, {
      toStatus: 'DELIVERED',
      cod: { collected: true, confirmed: true, ...cod },
    });

  const balances = async () => ({
    custody: await ledgerBalance(ctx.prisma, `DRIVER_CUSTODY:${driver.id}`),
    pending: await ledgerBalance(ctx.prisma, `MERCHANT_COD_PENDING:${merchant.id}`),
    merchant: await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`),
    fees: await ledgerBalance(ctx.prisma, 'DELIVERY_FEE_REVENUE'),
    receivable: await ledgerBalance(ctx.prisma, `DRIVER_RECEIVABLE:${driver.id}`),
    shortfallExpense: await ledgerBalance(ctx.prisma, 'COD_SHORTFALL_EXPENSE'),
  });

  it('posts a full COD delivery: custody, pending merchant funds and the fee', async () => {
    const id = await outForDelivery();
    const res = await deliver(id, { amount: '200' }).expect(200);
    expect(res.body.codInfo).toMatchObject({
      status: 'COLLECTED',
      expected: '200.00',
      collected: '200.00',
      outstanding: '0.00',
      shortfall: null,
    });
    expect(await balances()).toMatchObject({
      custody: '200.00',
      pending: '200.00',
      merchant: '-15.00',
      fees: '15.00',
    });
    expect(await ctx.prisma.journalEntry.count()).toBe(2);
  });

  it('posts only the fee for a delivery without COD (merchant owes it)', async () => {
    const id = await outForDelivery('0');
    const res = await deliver(id, { collected: false, amount: '0' }).expect(200);
    expect(res.body.codInfo.status).toBe('NOT_REQUIRED');
    expect(await balances()).toMatchObject({
      custody: '0.00',
      pending: '0.00',
      merchant: '-15.00',
      fees: '15.00',
    });
  });

  it('records a partial COD only with a reason, opens a shortfall and never charges the merchant', async () => {
    const id = await outForDelivery();
    expect((await deliver(id, { amount: '120' }).expect(422)).body.code).toBe(
      'SHIPMENT_COD_MISMATCH',
    );
    expect((await deliver(id, { amount: '250' }).expect(422)).body.code).toBe(
      'COD_EXCEEDS_EXPECTED',
    );
    expect((await deliver(id, { amount: '-5', partialReason: 'x' }).expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    const res = await deliver(id, {
      amount: '120',
      partialReason: 'Recipient had only 120',
    }).expect(200);
    const details = res.body as ShipmentDetails;
    expect(details.status).toBe('DELIVERED');
    expect(details.codInfo).toMatchObject({
      status: 'PARTIAL',
      collected: '120.00',
      outstanding: '80.00',
    });
    expect(details.codInfo.shortfall).toMatchObject({ status: 'OPEN', resolution: null });
    // The 80 shortfall is not booked against anyone yet.
    expect(await balances()).toMatchObject({
      custody: '120.00',
      pending: '120.00',
      merchant: '-15.00',
      receivable: '0.00',
      shortfallExpense: '0.00',
    });
    const merchantView = await api(merchant).get('/v1/merchant/finance/shortfalls').expect(200);
    expect(merchantView.body[0]).toMatchObject({ status: 'OPEN', outstandingAmount: '80.00' });
    expect(
      (await api(otherMerchant).get('/v1/merchant/finance/shortfalls').expect(200)).body,
    ).toEqual([]);
  });

  it('protects follow-up collections with idempotency keys, limits and locking', async () => {
    const id = await outForDelivery();
    await deliver(id, { amount: '120', partialReason: 'Paid part' }).expect(200);
    const path = `/v1/driver/shipments/${id}/collections`;

    expect((await api(driver).post(path, { amount: '30' }).expect(400)).body.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    const key = newKey();
    const first = await api(driver).post(path, { amount: '30' }, key).expect(200);
    expect(first.body).toMatchObject({
      collected: '150.00',
      outstanding: '50.00',
      codStatus: 'PARTIAL',
    });
    // A retry with the same key returns the same result and posts nothing new.
    const replay = await api(driver).post(path, { amount: '30' }, key).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await ctx.prisma.codCollection.count({ where: { shipmentId: id } })).toBe(2);
    expect((await api(driver).post(path, { amount: '31' }, key).expect(422)).body.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect((await api(driver).post(path, { amount: '60' }, newKey()).expect(422)).body.code).toBe(
      'COD_EXCEEDS_EXPECTED',
    );
    // Other drivers cannot collect on this shipment.
    const otherDriver = await createSignedInUser(ctx, 'DRIVER', 'd2@example.com');
    await api(otherDriver).post(path, { amount: '10' }, newKey()).expect(404);

    // Two concurrent collections of the full remainder: exactly one succeeds.
    const results = await Promise.all([
      api(driver).post(path, { amount: '50' }, newKey()),
      api(driver).post(path, { amount: '50' }, newKey()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const shipment = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id } });
    expect(shipment.codCollectedAmount.toFixed(2)).toBe('200.00');
    expect(shipment.codStatus).toBe('COLLECTED');
    const shortfall = await ctx.prisma.codShortfall.findUniqueOrThrow({
      where: { shipmentId: id },
    });
    expect(shortfall).toMatchObject({ status: 'RESOLVED', resolution: 'COLLECTED' });
    expect(await balances()).toMatchObject({ custody: '200.00', pending: '200.00' });
  });

  async function shortfallFor(id: string) {
    const res = await api(accountant).get('/v1/admin/finance/shortfalls').expect(200);
    return (res.body as CodShortfallItem[]).find((item) => item.shipment.id === id)!;
  }

  it('resolves a recipient shortfall only after a different person approves', async () => {
    const id = await outForDelivery();
    await deliver(id, { amount: '120', partialReason: 'Paid part' }).expect(200);
    const shortfall = await shortfallFor(id);
    const base = `/v1/admin/finance/shortfalls/${shortfall.id}`;

    await api(driver)
      .post(`${base}/propose`, { resolution: 'COMPANY_ABSORBS', note: 'x' })
      .expect(403);
    await api(viewer)
      .post(`${base}/propose`, { resolution: 'COMPANY_ABSORBS', note: 'Courtesy' })
      .expect(403);
    await api(ops).post(`${base}/propose`, { resolution: 'COMPANY_ABSORBS' }).expect(400);
    const proposed = await api(ops)
      .post(`${base}/propose`, {
        resolution: 'COMPANY_ABSORBS',
        note: 'Our driver accepted less by mistake',
      })
      .expect(200);
    expect(proposed.body).toMatchObject({ status: 'PENDING_APPROVAL', proposedAmount: '80.00' });

    // Operations cannot approve; the approval needs an idempotency key.
    await api(ops).post(`${base}/approve`, {}, newKey()).expect(403);
    expect((await api(accountant).post(`${base}/approve`, {}).expect(400)).body.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    const approved = await api(accountant)
      .post(`${base}/approve`, { note: 'OK' }, newKey())
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'RESOLVED',
      resolution: 'COMPANY_ABSORBS',
      resolvedAmount: '80.00',
    });
    expect(await balances()).toMatchObject({
      shortfallExpense: '80.00',
      merchant: '65.00',
      pending: '120.00',
    });
    const shipment = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id } });
    expect(shipment.codStatus).toBe('SHORTFALL_RESOLVED');
    // Approving again posts nothing.
    await api(admin).post(`${base}/approve`, {}, newKey()).expect(409);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'COD_SHORTFALL' } })).toBe(1);
  });

  it('forbids self-approval and enforces the configurable threshold', async () => {
    const id = await outForDelivery('500');
    await deliver(id, { amount: '200', partialReason: 'Recipient paid 200' }).expect(200);
    const shortfall = await shortfallFor(id);
    const base = `/v1/admin/finance/shortfalls/${shortfall.id}`;
    await api(accountant)
      .post(`${base}/propose`, {
        resolution: 'DRIVER_RESPONSIBLE',
        note: 'Driver released goods without payment',
      })
      .expect(200);
    expect(
      (await api(accountant).post(`${base}/approve`, {}, newKey()).expect(403)).body.code,
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    // 300 > 200 threshold: only SUPER_ADMIN.
    await api(admin).post(`${base}/reject`, { note: 'Check with the driver first' }).expect(200);
    await api(ops)
      .post(`${base}/propose`, { resolution: 'DRIVER_RESPONSIBLE', note: 'Driver confirmed' })
      .expect(200);
    expect(
      (await api(accountant).post(`${base}/approve`, {}, newKey()).expect(403)).body.code,
    ).toBe('APPROVAL_LIMIT_EXCEEDED');

    // The threshold is configurable by SUPER_ADMIN only, with a reason and history.
    await api(accountant)
      .put('/v1/admin/finance/settings/approval-threshold', { value: '500', reason: 'x' })
      .expect(403);
    await api(admin)
      .put('/v1/admin/finance/settings/approval-threshold', { value: '500' })
      .expect(400);
    await api(admin)
      .put('/v1/admin/finance/settings/approval-threshold', {
        value: '500',
        reason: 'Larger daily volumes',
      })
      .expect(204);
    const settings = await api(viewer).get('/v1/admin/finance/settings').expect(200);
    expect(settings.body[0]).toMatchObject({
      value: '500.00',
      updatedBy: { id: admin.id },
      history: [
        expect.objectContaining({
          oldValue: '200.00',
          newValue: '500.00',
          reason: 'Larger daily volumes',
        }),
      ],
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'FINANCE_SETTING_CHANGED' } })).toBe(
      1,
    );

    await api(accountant).post(`${base}/approve`, {}, newKey()).expect(200);
    expect(await balances()).toMatchObject({ receivable: '300.00', merchant: '285.00' });
  });

  it('lets only the merchant accept a shortfall, explicitly', async () => {
    const id = await outForDelivery();
    await deliver(id, { amount: '150', partialReason: 'Discount agreed with merchant' }).expect(
      200,
    );
    const shortfall = await shortfallFor(id);
    await api(ops)
      .post(`/v1/admin/finance/shortfalls/${shortfall.id}/propose`, {
        resolution: 'MERCHANT_ACCEPTS',
        note: 'Merchant agreed the discount by phone',
      })
      .expect(200);
    // Staff cannot "approve" a merchant acceptance on the merchant's behalf.
    await api(admin)
      .post(`/v1/admin/finance/shortfalls/${shortfall.id}/approve`, {}, newKey())
      .expect(409);
    await api(otherMerchant)
      .post(`/v1/merchant/finance/shortfalls/${shortfall.id}/accept`, {})
      .expect(404);
    const accepted = await api(merchant)
      .post(`/v1/merchant/finance/shortfalls/${shortfall.id}/accept`, {})
      .expect(200);
    expect(accepted.body).toMatchObject({
      status: 'RESOLVED',
      resolution: 'MERCHANT_ACCEPTS',
      resolvedAmount: '50.00',
    });
    expect(accepted.body.merchantAcceptedAt).toEqual(expect.any(String));
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'COD_SHORTFALL' } })).toBe(0);
  });

  it('corrects a posted fee by reversal and re-posting, approved by a second person', async () => {
    const id = await outForDelivery();
    await deliver(id, { amount: '200' }).expect(200);
    const fee = await ctx.prisma.journalEntry.findFirstOrThrow({ where: { kind: 'DELIVERY_FEE' } });

    await api(ops)
      .post(`/v1/admin/finance/shipments/${id}/fee-correction`, { fee: '10', reason: 'x y z' })
      .expect(403);
    const requested = await api(accountant)
      .post(`/v1/admin/finance/shipments/${id}/fee-correction`, {
        fee: '10',
        reason: 'Agreed discount',
      })
      .expect(201);
    const path = `/v1/admin/finance/fee-corrections/${requested.body.id}/approve`;
    expect((await api(accountant).post(path, {}, newKey()).expect(403)).body.code).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    await api(admin).post(path, {}, newKey()).expect(200);

    const reversal = await ctx.prisma.journalEntry.findFirstOrThrow({
      where: { kind: 'REVERSAL' },
    });
    expect(reversal.reversalOfId).toBe(fee.id);
    expect(await balances()).toMatchObject({ merchant: '-10.00', fees: '10.00' });
    const details = await api(admin).get(`/v1/admin/shipments/${id}`).expect(200);
    expect(details.body.deliveryFee).toBe('10.00');
    expect(details.body.pricing.overrides.at(-1)).toMatchObject({
      phase: 'POST_DELIVERY',
      status: 'APPLIED',
      approvedBy: { id: admin.id },
    });

    // Posted history is immutable at the database level.
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE journal_lines SET amount = 1 WHERE entry_id = '${fee.id}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.journalEntry.delete({ where: { id: fee.id } })).rejects.toThrow();
  });

  it('applies merchant adjustments only after approval', async () => {
    const res = await api(accountant)
      .post('/v1/admin/finance/adjustments', {
        type: 'MERCHANT_CREDIT',
        merchantId: merchant.id,
        amount: '25',
        reason: 'Compensation for a delayed delivery',
      })
      .expect(201);
    expect(await balances()).toMatchObject({ merchant: '0.00' });
    await api(merchant).get('/v1/admin/finance/adjustments').expect(403);
    await api(admin)
      .post(`/v1/admin/finance/adjustments/${res.body.id}/approve`, {}, newKey())
      .expect(200);
    expect(await balances()).toMatchObject({ merchant: '25.00' });
    expect(await ledgerBalance(ctx.prisma, 'ADJUSTMENT_EXPENSE')).toBe('25.00');
    await api(admin)
      .post(`/v1/admin/finance/adjustments/${res.body.id}/approve`, {}, newKey())
      .expect(409);
  });
});
