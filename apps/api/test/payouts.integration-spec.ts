import request from 'supertest';
import type { Server as App } from 'node:http';
import type { MerchantFinanceSummary, PayoutItem } from '@coobra/shared';
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
const newKey = () => `payout-key-${Date.now()}-${++keyCounter}`;

describe('Merchant payouts (PostgreSQL integration)', () => {
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

  async function deliveredCod(codAmount: string, owner = merchant) {
    const created = await api(owner)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount,
      })
      .expect(201);
    const id = created.body.id as string;
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    await api(driver)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: codAmount !== '0', amount: codAmount, confirmed: true },
      })
      .expect(200);
    return id;
  }

  /** Delivered COD whose cash the driver handed over (funds confirmed). */
  async function fundedMerchant(codAmount: string) {
    await deliveredCod(codAmount);
    const settlement = await api(driver)
      .post('/v1/driver/finance/settlements', { declaredAmount: codAmount }, newKey())
      .expect(201);
    await api(accountant)
      .post(
        `/v1/admin/finance/settlements/${settlement.body.id}/confirm`,
        { countedAmount: codAmount, channel: 'HUB' },
        newKey(),
      )
      .expect(200);
  }

  const createPayout = (
    amount: string,
    method = 'CASH',
    by = accountant,
    merchantId = merchant.id,
  ) => api(by).post('/v1/admin/finance/payouts', { merchantId, amount, method }, newKey());
  const approve = (id: string, by = admin, key = newKey()) =>
    api(by).post(`/v1/admin/finance/payouts/${id}/approve`, {}, key);
  const pay = (id: string, reference: string, by = accountant, key = newKey()) =>
    api(by).post(`/v1/admin/finance/payouts/${id}/pay`, { reference }, key);
  const summary = async (user = merchant) =>
    (await api(user).get('/v1/merchant/finance').expect(200)).body as MerchantFinanceSummary;

  it('pays a partial payout after approval by a different person', async () => {
    await fundedMerchant('200');
    expect(await summary()).toMatchObject({
      pending: '0.00',
      balance: '185.00',
      reserved: '0.00',
      available: '185.00',
    });

    const payout = (await createPayout('100').expect(201)).body as PayoutItem;
    expect(payout).toMatchObject({ status: 'PENDING_APPROVAL', createdBy: { id: accountant.id } });
    expect((await approve(payout.id, accountant).expect(403)).body.code).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    await approve(payout.id, ops).expect(403);
    await approve(payout.id, viewer).expect(403);
    await approve(payout.id, merchant).expect(403);
    await approve(payout.id).expect(200);
    expect(await summary()).toMatchObject({
      balance: '185.00',
      reserved: '100.00',
      available: '85.00',
    });

    await api(accountant)
      .post(`/v1/admin/finance/payouts/${payout.id}/pay`, {}, newKey())
      .expect(400);
    const paid = (await pay(payout.id, 'CASH-0001').expect(200)).body as PayoutItem;
    expect(paid).toMatchObject({
      status: 'PAID',
      reference: 'CASH-0001',
      approvedBy: { id: admin.id },
      paidBy: { id: accountant.id },
    });
    expect(await summary()).toMatchObject({
      balance: '85.00',
      reserved: '0.00',
      available: '85.00',
    });
    expect(await ledgerBalance(ctx.prisma, 'COMPANY_CASH_HUB')).toBe('100.00');
    expect((await summary()).payouts).toHaveLength(1);
  });

  it('never pays more than the confirmed, funded balance', async () => {
    // Collected but not yet handed over by the driver: nothing is available.
    await deliveredCod('300');
    expect(await summary()).toMatchObject({
      pending: '300.00',
      balance: '-15.00',
      available: '0.00',
    });
    expect((await createPayout('50').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');

    const settlement = await api(driver)
      .post('/v1/driver/finance/settlements', { declaredAmount: '300' }, newKey())
      .expect(201);
    await api(accountant)
      .post(
        `/v1/admin/finance/settlements/${settlement.body.id}/confirm`,
        { countedAmount: '300', channel: 'HUB' },
        newKey(),
      )
      .expect(200);
    expect((await createPayout('286').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');

    // Two payouts that each fit, but not together: the second approval is refused.
    const a = (await createPayout('150').expect(201)).body as PayoutItem;
    const b = (await createPayout('150').expect(201)).body as PayoutItem;
    await approve(a.id).expect(200);
    expect((await approve(b.id).expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    await api(accountant)
      .post(`/v1/admin/finance/payouts/${b.id}/cancel`, { note: 'Over the balance' })
      .expect(200);
    await pay(a.id, 'CASH-A').expect(200);
    expect(await summary()).toMatchObject({ balance: '135.00', available: '135.00' });
  });

  it('requires the company account to hold the cash and prevents duplicate payments', async () => {
    await fundedMerchant('200');
    const payout = (await createPayout('120', 'BANK_TRANSFER').expect(201)).body as PayoutItem;
    await approve(payout.id).expect(200);
    // The cash is at the hub, not in the bank yet.
    expect((await pay(payout.id, 'TRX-1').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    await api(accountant)
      .post(
        '/v1/admin/finance/treasury-transfers',
        { fromChannel: 'HUB', toChannel: 'BANK', amount: '200', reference: 'DEP-1' },
        newKey(),
      )
      .expect(201);
    await api(accountant)
      .post(
        '/v1/admin/finance/treasury-transfers',
        { fromChannel: 'HUB', toChannel: 'BANK', amount: '1' },
        newKey(),
      )
      .expect(422);

    const key = newKey();
    const [first, second] = await Promise.all([
      pay(payout.id, 'TRX-1', accountant, key),
      pay(payout.id, 'TRX-2', admin),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'MERCHANT_PAYOUT' } })).toBe(1);
    if (first.status === 200) {
      // A retried request (same key) replays the stored result instead of paying again.
      expect((await pay(payout.id, 'TRX-1', accountant, key).expect(200)).body.status).toBe('PAID');
    }
    expect(await ledgerBalance(ctx.prisma, 'COMPANY_BANK')).toBe('80.00');

    // References are unique per method.
    const another = (await createPayout('10', 'BANK_TRANSFER').expect(201)).body as PayoutItem;
    await approve(another.id).expect(200);
    const used = (await ctx.prisma.merchantPayout.findUniqueOrThrow({ where: { id: payout.id } }))
      .reference!;
    expect((await pay(another.id, used).expect(400)).body.fieldErrors).toEqual({
      reference: 'validation.finance.referenceTaken',
    });

    // Separation of duties is also a database constraint.
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE merchant_payouts SET approved_by_id = created_by_id WHERE id = '${another.id}'`,
      ),
    ).rejects.toThrow(/separation_of_duties/);
  });

  it('lets merchants request payouts and see only their own money', async () => {
    await fundedMerchant('200');
    const requested = await api(merchant)
      .post('/v1/merchant/finance/payouts', { amount: '50', method: 'E_WALLET' }, newKey())
      .expect(201);
    expect(requested.body).toMatchObject({
      requestedByMerchant: true,
      createdBy: { id: merchant.id },
    });
    await api(merchant)
      .post(`/v1/admin/finance/payouts/${requested.body.id}/approve`, {}, newKey())
      .expect(403);
    await api(otherMerchant)
      .post(`/v1/merchant/finance/payouts/${requested.body.id}/cancel`, { note: 'Not mine' })
      .expect(404);
    expect((await summary(otherMerchant)).payouts).toEqual([]);
    expect(await summary(otherMerchant)).toMatchObject({ balance: '0.00', available: '0.00' });
    await api(merchant)
      .post(`/v1/merchant/finance/payouts/${requested.body.id}/cancel`, { note: 'Changed my mind' })
      .expect(200);

    const second = await api(merchant)
      .post('/v1/merchant/finance/payouts', { amount: '50', method: 'CASH' }, newKey())
      .expect(201);
    await approve(second.body.id, accountant).expect(200);
    await api(merchant)
      .post(`/v1/merchant/finance/payouts/${second.body.id}/cancel`, { note: 'Too late' })
      .expect(409);

    await api(viewer).get('/v1/admin/finance/payouts').expect(200);
    await api(viewer).get('/v1/admin/finance/merchants').expect(200);
    await createPayout('10', 'CASH', viewer).expect(403);
    await createPayout('10', 'CASH', ops).expect(403);
  });

  it('records merchant payments for a debit balance', async () => {
    await deliveredCod('0');
    expect((await summary()).balance).toBe('-15.00');
    await api(accountant)
      .post(
        '/v1/admin/finance/merchant-payments',
        { merchantId: merchant.id, amount: '15', channel: 'HUB', reference: 'R-1' },
        newKey(),
      )
      .expect(201);
    expect(await summary()).toMatchObject({ balance: '0.00', available: '0.00' });
    expect(await ledgerBalance(ctx.prisma, 'COMPANY_CASH_HUB')).toBe('15.00');
  });
});
