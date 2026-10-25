import request from 'supertest';
import type { Server as App } from 'node:http';
import type { ShipmentDetails } from '@coobra/shared';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  type TestContext,
  type TestUser,
} from './helpers.js';

const shipmentInput = {
  recipientName: 'Ahmad Khalil',
  recipientPhone: '٠٥٩٩-١٢٣-٤٥٦',
  governorate: 'RAMALLAH_ALBIREH',
  city: 'Al-Bireh',
  addressLine: 'Al-Quds street, building 5',
  landmark: 'Next to the bakery',
  codAmount: '150',
};

describe('Shipments (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let viewer: TestUser;
  let accountant: TestUser;
  let merchantA: TestUser;
  let merchantB: TestUser;
  let driver1: TestUser;
  let driver2: TestUser;
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
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'accountant@example.com');
    merchantA = await createSignedInUser(ctx, 'MERCHANT', 'a@example.com', {
      businessName: 'Store A',
    });
    merchantB = await createSignedInUser(ctx, 'MERCHANT', 'b@example.com', {
      businessName: 'Store B',
    });
    driver1 = await createSignedInUser(ctx, 'DRIVER', 'd1@example.com', { fullName: 'Driver One' });
    driver2 = await createSignedInUser(ctx, 'DRIVER', 'd2@example.com', { fullName: 'Driver Two' });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  async function merchantCreates(merchant = merchantA, overrides: object = {}) {
    const res = await api(merchant)
      .post('/v1/merchant/shipments', { ...shipmentInput, ...overrides })
      .expect(201);
    return res.body as ShipmentDetails;
  }

  function assign(shipmentId: string, driver: TestUser, by = ops) {
    return api(by).post(`/v1/admin/shipments/${shipmentId}/assign`, { driverId: driver.id });
  }

  function transition(user: TestUser, shipmentId: string, body: object) {
    const base =
      user.role === 'MERCHANT'
        ? '/v1/merchant/shipments'
        : user.role === 'DRIVER'
          ? '/v1/driver/shipments'
          : '/v1/admin/shipments';
    return api(user).post(`${base}/${shipmentId}/transitions`, body);
  }

  async function outForDelivery(shipmentId: string, driver = driver1) {
    await assign(shipmentId, driver).expect(200);
    await transition(driver, shipmentId, { toStatus: 'PICKED_UP' }).expect(200);
    await transition(driver, shipmentId, { toStatus: 'OUT_FOR_DELIVERY' }).expect(200);
  }

  const deliverBody = (amount: string, collected = true) => ({
    toStatus: 'DELIVERED',
    cod: { collected, amount, confirmed: true },
  });

  it('lets a merchant create a shipment for their own account only', async () => {
    const shipment = await merchantCreates(merchantA, {
      merchantId: merchantB.id,
      deliveryFee: '5',
      status: 'DELIVERED',
    });
    expect(shipment).toMatchObject({
      status: 'CREATED',
      recipientPhone: '0599123456',
      codAmount: '150.00',
      deliveryFee: null,
      currency: 'ILS',
      creatorRole: 'MERCHANT',
      merchant: { id: merchantA.id, businessName: 'Store A' },
      createdBy: { id: merchantA.id, role: 'MERCHANT' },
    });
    expect(shipment.trackingNumber).toMatch(/^CB-\d{8}$/);
    expect(shipment.history).toHaveLength(1);
    expect(shipment.history[0]).toMatchObject({ fromStatus: null, toStatus: 'CREATED' });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'SHIPMENT_CREATED' },
    });
    expect(audit).toMatchObject({ actorUserId: merchantA.id, targetUserId: merchantA.id });
    expect(audit.metadata).toMatchObject({ onBehalfOfMerchant: false });

    const invalid = await api(merchantA)
      .post('/v1/merchant/shipments', { ...shipmentInput, recipientPhone: '12', codAmount: 'x' })
      .expect(400);
    expect(invalid.body.fieldErrors).toEqual({
      recipientPhone: 'validation.phone.invalid',
      codAmount: 'validation.money.invalid',
    });
  });

  it('lets SUPER_ADMIN and OPERATIONS create shipments on behalf of a merchant, recorded as staff', async () => {
    const res = await api(ops)
      .post('/v1/admin/shipments', { ...shipmentInput, merchantId: merchantA.id, deliveryFee: 20 })
      .expect(201);
    const shipment = res.body as ShipmentDetails;
    expect(shipment).toMatchObject({
      creatorRole: 'OPERATIONS',
      createdBy: { id: ops.id, role: 'OPERATIONS' },
      merchant: { id: merchantA.id },
      deliveryFee: '20.00',
    });
    expect(shipment.history[0]?.actor).toMatchObject({ id: ops.id, role: 'OPERATIONS' });

    // The merchant sees it in their own list.
    const list = await api(merchantA).get('/v1/merchant/shipments').expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([shipment.id]);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'SHIPMENT_CREATED' },
    });
    expect(audit).toMatchObject({ actorUserId: ops.id, targetUserId: merchantA.id });
    expect(audit.metadata).toMatchObject({ onBehalfOfMerchant: true });

    await api(admin)
      .post('/v1/admin/shipments', { ...shipmentInput, merchantId: merchantB.id })
      .expect(201);

    // Only active merchants can own shipments.
    const wrong = await api(ops)
      .post('/v1/admin/shipments', { ...shipmentInput, merchantId: driver1.id })
      .expect(422);
    expect(wrong.body.code).toBe('SHIPMENT_MERCHANT_INVALID');
    await api(ops).post('/v1/admin/shipments', shipmentInput).expect(400);
  });

  it('isolates merchants from each other, whatever the IDs or parameters', async () => {
    const own = await merchantCreates(merchantA);
    await merchantCreates(merchantB);

    await api(merchantB).get(`/v1/merchant/shipments/${own.id}`).expect(404);
    await transition(merchantB, own.id, { toStatus: 'CANCELLED', reason: 'Not mine' }).expect(404);
    const list = await api(merchantB)
      .get(`/v1/merchant/shipments?merchantId=${merchantA.id}`)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].merchant.id).toBe(merchantB.id);

    await api(merchantA).get('/v1/admin/shipments').expect(403);
    await api(merchantA).get(`/v1/driver/shipments/${own.id}`).expect(403);
    await api(merchantA).get('/v1/merchant/shipments/not-a-uuid').expect(404);
  });

  it('keeps OWNER_VIEWER and ACCOUNTANT read-only', async () => {
    const shipment = await merchantCreates();
    for (const user of [viewer, accountant]) {
      await api(user).get('/v1/admin/shipments').expect(200);
      await api(user).get(`/v1/admin/shipments/${shipment.id}`).expect(200);
      await api(user).get('/v1/admin/shipments/summary').expect(200);
      await api(user)
        .post('/v1/admin/shipments', { ...shipmentInput, merchantId: merchantA.id })
        .expect(403);
      await assign(shipment.id, driver1, user).expect(403);
      await transition(user, shipment.id, { toStatus: 'CANCELLED', reason: 'Test' }).expect(403);
    }
    await api(driver1).post('/v1/merchant/shipments', shipmentInput).expect(403);
    await api(driver1)
      .post('/v1/admin/shipments', { ...shipmentInput, merchantId: merchantA.id })
      .expect(403);
  });

  it('assigns and reassigns drivers, who only see their own shipments', async () => {
    const shipment = await merchantCreates();
    await api(driver1).get(`/v1/driver/shipments/${shipment.id}`).expect(404);

    const assigned = await assign(shipment.id, driver1).expect(200);
    expect(assigned.body).toMatchObject({ status: 'ASSIGNED', driver: { id: driver1.id } });
    await api(driver1).get(`/v1/driver/shipments/${shipment.id}`).expect(200);

    // Assigning the same driver again changes nothing.
    await assign(shipment.id, driver1).expect(200);

    const reassigned = await assign(shipment.id, driver2).expect(200);
    expect(reassigned.body.driver.id).toBe(driver2.id);
    await api(driver1).get(`/v1/driver/shipments/${shipment.id}`).expect(404);
    await transition(driver1, shipment.id, { toStatus: 'PICKED_UP' }).expect(404);
    const list1 = await api(driver1).get('/v1/driver/shipments?scope=active').expect(200);
    expect(list1.body.total).toBe(0);
    const list2 = await api(driver2).get('/v1/driver/shipments?scope=active').expect(200);
    expect(list2.body.total).toBe(1);

    const history = (reassigned.body as ShipmentDetails).history;
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.driver?.id ?? null])).toEqual([
      [null, 'CREATED', null],
      ['CREATED', 'ASSIGNED', driver1.id],
      ['ASSIGNED', 'ASSIGNED', driver2.id],
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'SHIPMENT_ASSIGNED' } })).toBe(2);

    const notDriver = await assign(shipment.id, merchantB).expect(422);
    expect(notDriver.body.code).toBe('SHIPMENT_DRIVER_INVALID');
    await api(driver1)
      .post(`/v1/admin/shipments/${shipment.id}/assign`, { driverId: driver1.id })
      .expect(403);

    const drivers = await api(ops).get('/v1/admin/drivers').expect(200);
    expect(drivers.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: driver2.id, activeShipments: 1 })]),
    );
  });

  it('runs the delivery lifecycle with consistent history and a COD record', async () => {
    const shipment = await merchantCreates();
    await outForDelivery(shipment.id);
    const delivered = await transition(driver1, shipment.id, deliverBody('150.00')).expect(200);
    const body = delivered.body as ShipmentDetails;

    expect(body).toMatchObject({ status: 'DELIVERED', deliveryAttempts: 1 });
    expect(body.deliveredAt).toEqual(expect.any(String));
    expect(body.pickedUpAt).toEqual(expect.any(String));
    expect(body.cod).toMatchObject({
      collected: true,
      expectedAmount: '150.00',
      collectedAmount: '150.00',
      driver: { id: driver1.id },
    });
    const stored = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(stored.deliveredById).toBe(driver1.id);

    // History is a chain: every entry starts where the previous one ended.
    const statuses = body.history.map((h) => h.toStatus);
    expect(statuses).toEqual(['CREATED', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    body.history.forEach((entry, index) => {
      expect(entry.fromStatus).toBe(index === 0 ? null : body.history[index - 1]?.toStatus);
    });
    expect(body.history.at(-1)?.actor).toMatchObject({ id: driver1.id, role: 'DRIVER' });

    // Completed shipments cannot be modified.
    const again = await transition(driver1, shipment.id, deliverBody('150')).expect(409);
    expect(again.body.code).toBe('SHIPMENT_INVALID_TRANSITION');
    await transition(ops, shipment.id, { toStatus: 'CANCELLED', reason: 'Too late' }).expect(409);
    await assign(shipment.id, driver2).expect(409);

    const historyView = await api(driver1).get('/v1/driver/shipments?scope=history').expect(200);
    expect(historyView.body.total).toBe(1);
  });

  it('rejects invalid jumps, unauthorised actors and missing reasons', async () => {
    const shipment = await merchantCreates();
    await assign(shipment.id, driver1).expect(200);

    const jump = await transition(driver1, shipment.id, { toStatus: 'DELIVERED' }).expect(409);
    expect(jump.body.code).toBe('SHIPMENT_INVALID_TRANSITION');
    await transition(driver1, shipment.id, { toStatus: 'OUT_FOR_DELIVERY' }).expect(409);
    // Merchants cannot cancel once a driver is assigned; staff can, with a reason.
    await transition(merchantA, shipment.id, {
      toStatus: 'CANCELLED',
      reason: 'Changed mind',
    }).expect(403);

    await transition(driver1, shipment.id, { toStatus: 'PICKED_UP' }).expect(200);
    await transition(driver1, shipment.id, { toStatus: 'OUT_FOR_DELIVERY' }).expect(200);

    // Merchants and staff can never mark a shipment delivered.
    await transition(merchantA, shipment.id, deliverBody('150')).expect(403);
    await transition(ops, shipment.id, deliverBody('150')).expect(403);

    const noReason = await transition(driver1, shipment.id, { toStatus: 'DELIVERY_FAILED' }).expect(
      400,
    );
    expect(noReason.body.fieldErrors).toEqual({ reason: 'validation.reason.required' });
    await transition(driver1, shipment.id, {
      toStatus: 'DELIVERY_FAILED',
      reason: 'Recipient did not answer',
    }).expect(200);

    // The merchant asks for a return; operations confirm it came back.
    await transition(merchantA, shipment.id, { toStatus: 'RETURN_REQUESTED' }).expect(400);
    const returnRequested = await transition(merchantA, shipment.id, {
      toStatus: 'RETURN_REQUESTED',
      reason: 'Customer refused',
    }).expect(200);
    expect(returnRequested.body).toMatchObject({
      returnReason: 'Customer refused',
      failureReason: 'Recipient did not answer',
    });
    await transition(merchantA, shipment.id, { toStatus: 'RETURNED' }).expect(403);
    await transition(ops, shipment.id, { toStatus: 'RETURNED' }).expect(200);

    const cancellable = await merchantCreates();
    const cancelled = await transition(merchantA, cancellable.id, {
      toStatus: 'CANCELLED',
      reason: 'Order cancelled by customer',
    }).expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'Order cancelled by customer',
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'SHIPMENT_CANCELLED' } })).toBe(1);
  });

  it('validates the cash-on-delivery confirmation', async () => {
    const shipment = await merchantCreates();
    await outForDelivery(shipment.id);

    await transition(driver1, shipment.id, { toStatus: 'DELIVERED' }).expect(400);
    await transition(driver1, shipment.id, {
      toStatus: 'DELIVERED',
      cod: { collected: true, amount: '150' },
    }).expect(400);
    const wrongAmount = await transition(driver1, shipment.id, deliverBody('140')).expect(422);
    expect(wrongAmount.body.code).toBe('SHIPMENT_COD_MISMATCH');
    await transition(driver1, shipment.id, deliverBody('0', false)).expect(422);
    expect(await ctx.prisma.codCollection.count()).toBe(0);
    await transition(driver1, shipment.id, deliverBody('150')).expect(200);

    const noCod = await merchantCreates(merchantA, { codAmount: '0' });
    await outForDelivery(noCod.id);
    await transition(driver1, noCod.id, deliverBody('10')).expect(422);
    const ok = await transition(driver1, noCod.id, deliverBody('0', false)).expect(200);
    expect(ok.body.cod).toMatchObject({ collected: false, collectedAmount: '0.00' });
  });

  it('handles concurrent status updates and assignments safely', async () => {
    const shipment = await merchantCreates();
    await assign(shipment.id, driver1).expect(200);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => transition(driver1, shipment.id, { toStatus: 'PICKED_UP' })),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const res of results.filter((r) => r.status !== 200)) {
      expect(res.status).toBe(409);
      expect(['SHIPMENT_CONCURRENT_UPDATE', 'SHIPMENT_INVALID_TRANSITION']).toContain(
        res.body.code,
      );
    }
    expect(
      await ctx.prisma.shipmentStatusHistory.count({
        where: { shipmentId: shipment.id, toStatus: 'PICKED_UP' },
      }),
    ).toBe(1);

    const other = await merchantCreates();
    const assignments = await Promise.all([assign(other.id, driver1), assign(other.id, driver2)]);
    expect(assignments.filter((res) => res.status === 200).length).toBeGreaterThanOrEqual(1);
    const final = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: other.id } });
    const lastEntry = await ctx.prisma.shipmentStatusHistory.findFirstOrThrow({
      where: { shipmentId: other.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(lastEntry.driverId).toBe(final.driverId);
    expect(final.version).toBe(
      await ctx.prisma.shipmentStatusHistory.count({
        where: { shipmentId: other.id, NOT: { toStatus: 'CREATED' } },
      }),
    );
  });

  it('paginates, searches and filters lists and counts statuses', async () => {
    const first = await merchantCreates(merchantA, { recipientName: 'Lina Haddad' });
    await merchantCreates(merchantA, { recipientPhone: '+970 568 777 888', governorate: 'NABLUS' });
    await merchantCreates(merchantB);
    await assign(first.id, driver1).expect(200);

    const page1 = await api(ops).get('/v1/admin/shipments?pageSize=2&page=1').expect(200);
    expect(page1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.body.items).toHaveLength(2);
    const page2 = await api(ops).get('/v1/admin/shipments?pageSize=2&page=2').expect(200);
    expect(page2.body.items).toHaveLength(1);

    const search = (query: string) =>
      api(ops)
        .get(`/v1/admin/shipments?${query}`)
        .expect(200)
        .then((res) => res.body.total as number);
    expect(await search(`q=${first.trackingNumber.toLowerCase()}`)).toBe(1);
    expect(await search('q=lina')).toBe(1);
    expect(await search('q=568777')).toBe(1);
    expect(await search('status=ASSIGNED')).toBe(1);
    expect(await search('governorate=NABLUS')).toBe(1);
    expect(await search(`merchantId=${merchantB.id}`)).toBe(1);
    expect(await search(`driverId=${driver1.id}`)).toBe(1);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(await search(`createdFrom=${encodeURIComponent(tomorrow)}`)).toBe(0);
    await api(ops).get('/v1/admin/shipments?status=LOST').expect(400);

    const summary = await api(viewer).get('/v1/admin/shipments/summary').expect(200);
    expect(summary.body).toMatchObject({ total: 3, counts: { CREATED: 2, ASSIGNED: 1 } });

    const merchants = await api(ops).get('/v1/admin/merchants?q=store b').expect(200);
    expect(merchants.body).toEqual([expect.objectContaining({ id: merchantB.id })]);
  });
});
