import request from 'supertest';
import type { Server as App } from 'node:http';
import type { ReturnListItem, ShipmentDetails } from '@coobra/shared';
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

describe('Returns workflow (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let merchant: TestUser;
  let driver: TestUser;
  let returnDriver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'm@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    returnDriver = await createSignedInUser(ctx, 'DRIVER', 'rd@example.com');
    // Ramallah → Ramallah has a 10 ILS return fee; Ramallah → Nablus has none configured.
    zones = await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterEach(async () => {
    await assertLedgerInvariants(ctx.prisma);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  const move = (user: TestUser, id: string, toStatus: string, reason?: string) => {
    const base =
      user.role === 'DRIVER' ? 'driver' : user.role === 'MERCHANT' ? 'merchant' : 'admin';
    return api(user).post(`/v1/${base}/shipments/${id}/transitions`, {
      toStatus,
      ...(reason ? { reason } : {}),
    });
  };

  /** A shipment whose delivery failed and whose merchant asked for it back. */
  async function returnRequested(destinationZoneId = zones.ramallah) {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId,
        addressLine: 'Street 1',
        codAmount: '200',
      })
      .expect(201);
    const id = created.body.id as string;
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    await move(driver, id, 'PICKED_UP').expect(200);
    await move(driver, id, 'OUT_FOR_DELIVERY').expect(200);
    await move(driver, id, 'DELIVERY_FAILED', 'Recipient refused the parcel').expect(200);
    await move(merchant, id, 'RETURN_REQUESTED', 'Customer cancelled the order').expect(200);
    return id;
  }

  it('runs a return trip and posts the configured return fee once returned', async () => {
    const id = await returnRequested();
    let details = (await api(merchant).get(`/v1/merchant/shipments/${id}`).expect(200))
      .body as ShipmentDetails;
    expect(details.returnInfo).toMatchObject({
      requestReason: 'Customer cancelled the order',
      requestedBy: { id: merchant.id },
      feeStatus: 'SET',
      feeAmount: '10.00',
      closedAt: null,
    });

    await api(merchant).post(`/v1/admin/shipments/${id}/return/approve`, {}).expect(403);
    const approved = await api(ops)
      .post(`/v1/admin/shipments/${id}/return/approve`, {
        driverId: returnDriver.id,
        note: 'Tomorrow morning',
      })
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'RETURN_APPROVED',
      driver: { id: returnDriver.id },
    });
    // QA BUG-005: confirming again with the same driver is a no-op (no duplicate history);
    // choosing another driver is a reassignment and is recorded.
    const historyCount = () =>
      ctx.prisma.shipmentStatusHistory.count({
        where: { shipmentId: id, toStatus: 'RETURN_APPROVED' },
      });
    await api(ops)
      .post(`/v1/admin/shipments/${id}/return/approve`, { driverId: returnDriver.id })
      .expect(200);
    expect(await historyCount()).toBe(1);
    await api(ops)
      .post(`/v1/admin/shipments/${id}/return/approve`, { driverId: driver.id })
      .expect(200);
    expect(await historyCount()).toBe(2);
    await api(ops)
      .post(`/v1/admin/shipments/${id}/return/approve`, { driverId: returnDriver.id })
      .expect(200);
    expect(await historyCount()).toBe(3);

    // The return task belongs to the return driver only.
    await api(driver).get(`/v1/driver/shipments/${id}`).expect(404);
    const tasks = await api(returnDriver).get('/v1/driver/shipments?scope=active').expect(200);
    expect(tasks.body.items.map((item: { id: string }) => item.id)).toEqual([id]);

    // Office hand-over is staff-only; the driver has to carry it first.
    await move(returnDriver, id, 'RETURNED').expect(403);
    await move(returnDriver, id, 'RETURN_IN_TRANSIT').expect(200);
    await move(returnDriver, id, 'RETURNED_TO_HUB').expect(200);
    await move(returnDriver, id, 'RETURNED').expect(403);
    await move(merchant, id, 'RETURNED').expect(403);
    details = (await move(ops, id, 'RETURNED').expect(200)).body as ShipmentDetails;

    expect(details.status).toBe('RETURNED');
    expect(details.returnInfo).toMatchObject({ feeStatus: 'POSTED', feeAmount: '10.00' });
    expect(details.returnInfo?.closedAt).toEqual(expect.any(String));
    expect(details.history.map((entry) => entry.toStatus)).toEqual([
      'CREATED',
      'ASSIGNED',
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'DELIVERY_FAILED',
      'RETURN_REQUESTED',
      'RETURN_APPROVED',
      'RETURN_APPROVED',
      'RETURN_APPROVED',
      'RETURN_IN_TRANSIT',
      'RETURNED_TO_HUB',
      'RETURNED',
    ]);
    // Only the return fee is charged: no delivery fee and no COD movement.
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-10.00');
    expect(await ledgerBalance(ctx.prisma, 'RETURN_FEE_REVENUE')).toBe('10.00');
    expect(await ledgerBalance(ctx.prisma, 'DELIVERY_FEE_REVENUE')).toBe('0.00');
    expect(await ctx.prisma.journalEntry.count()).toBe(1);
    // Final: nothing else can happen.
    await move(ops, id, 'RETURNED_TO_HUB').expect(409);
  });

  it('requires an explicit fee or waiver when no return fee is configured', async () => {
    const id = await returnRequested(zones.nablus);
    const open = await api(viewer)
      .get('/v1/admin/returns?open=true&feeStatus=RETURN_FEE_UNCONFIGURED')
      .expect(200);
    expect((open.body as ReturnListItem[]).map((item) => item.shipment.id)).toEqual([id]);

    // Collected at the office: physically returned, but the fee is still undecided.
    await move(ops, id, 'RETURNED').expect(200);
    let info = (await api(ops).get(`/v1/admin/shipments/${id}`).expect(200)).body.returnInfo;
    expect(info).toMatchObject({
      feeStatus: 'RETURN_FEE_UNCONFIGURED',
      feeAmount: null,
      closedAt: null,
    });
    expect(await ctx.prisma.journalEntry.count()).toBe(0);

    await api(ops)
      .post(`/v1/admin/returns/${id}/fee`, { amount: '7', reason: 'Standard' })
      .expect(403);
    await api(viewer).post(`/v1/admin/returns/${id}/waive`, { reason: 'Goodwill' }).expect(403);
    await api(accountant).post(`/v1/admin/returns/${id}/fee`, { amount: '7' }).expect(400);
    info = (
      await api(accountant)
        .post(`/v1/admin/returns/${id}/fee`, { amount: '7', reason: 'Nablus standard return' })
        .expect(200)
    ).body;
    expect(info).toMatchObject({
      feeStatus: 'POSTED',
      feeAmount: '7.00',
      feeReason: 'Nablus standard return',
    });
    expect(info.closedAt).toEqual(expect.any(String));
    expect(await ledgerBalance(ctx.prisma, 'RETURN_FEE_REVENUE')).toBe('7.00');
    // Posted fees are final here; corrections go through financial adjustments.
    await api(accountant)
      .post(`/v1/admin/returns/${id}/waive`, { reason: 'Changed mind' })
      .expect(409);
    expect((await api(viewer).get('/v1/admin/returns?open=true').expect(200)).body).toEqual([]);
  });

  it('waives a configured fee with a reason and closes without posting', async () => {
    const id = await returnRequested();
    await api(accountant)
      .post(`/v1/admin/returns/${id}/waive`, { reason: 'Our driver damaged the parcel' })
      .expect(200);
    await api(ops).post(`/v1/admin/shipments/${id}/return/approve`, {}).expect(200);
    const details = (await move(ops, id, 'RETURNED').expect(200)).body as ShipmentDetails;
    expect(details.returnInfo).toMatchObject({ feeStatus: 'WAIVED', feeAmount: '0.00' });
    expect(details.returnInfo?.closedAt).toEqual(expect.any(String));
    expect(await ctx.prisma.journalEntry.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'RETURN_FEE_WAIVED' } })).toBe(1);
  });

  it('only approves returns that were requested', async () => {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount: '50',
      })
      .expect(201);
    await api(ops).post(`/v1/admin/shipments/${created.body.id}/return/approve`, {}).expect(409);
    await api(accountant)
      .post(`/v1/admin/returns/${created.body.id}/fee`, { amount: '5', reason: 'Not a return' })
      .expect(409);
  });
});
