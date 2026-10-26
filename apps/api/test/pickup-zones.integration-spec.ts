import request from 'supertest';
import type { Server as App } from 'node:http';
import type { MerchantPickupZoneState, PickupZoneRequestItem } from '@coobra/shared';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  zoneId,
  type TestContext,
  type TestUser,
} from './helpers.js';

describe('Merchant pickup-zone change approval (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let merchant: TestUser;
  let otherMerchant: TestUser;
  let driver: TestUser;
  let ramallah: string;
  let nablus: string;
  let hebron: string;
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
    put: (path: string, body: object = {}) =>
      request(server()).put(path).set('authorization', `Bearer ${user.token}`).send(body),
    patch: (path: string, body: object = {}) =>
      request(server()).patch(path).set('authorization', `Bearer ${user.token}`).send(body),
    delete: (path: string) =>
      request(server()).delete(path).set('authorization', `Bearer ${user.token}`),
  });
  const requestZone = (user: TestUser, zone: string) =>
    api(user).put('/v1/merchant/pickup-zone', { zoneId: zone });
  const quote = (user: TestUser, body: object) =>
    api(user).post('/v1/merchant/pricing/quote', body).expect(200);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'm@example.com');
    otherMerchant = await createSignedInUser(ctx, 'MERCHANT', 'm2@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    ramallah = await zoneId(ctx.prisma, 'RAMALLAH_ALBIREH');
    nablus = await zoneId(ctx.prisma, 'NABLUS');
    hebron = await zoneId(ctx.prisma, 'HEBRON');
    // Different prices by origin, so the quote shows which zone priced it.
    for (const [origin, fee] of [
      [ramallah, '20'],
      [nablus, '35'],
    ] as const) {
      await api(accountant)
        .post('/v1/admin/pricing-rules', {
          originZoneId: origin,
          destinationZoneId: hebron,
          deliveryFee: fee,
        })
        .expect(201);
    }
    await api(ops)
      .put(`/v1/admin/merchants/${merchant.id}/pickup-zone`, { zoneId: ramallah })
      .expect(204);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('keeps pricing from the approved zone until staff approve a change', async () => {
    const requested = (await requestZone(merchant, nablus).expect(202))
      .body as MerchantPickupZoneState;
    expect(requested).toMatchObject({
      approvedZoneId: ramallah,
      pending: { requestedZoneId: nablus, previousZoneId: ramallah, status: 'PENDING' },
    });
    expect((await quote(merchant, { destinationZoneId: hebron })).body.finalFee).toBe('20.00');

    // Only shipment managers decide; never the merchant, a driver or finance.
    const id = requested.pending!.id;
    for (const user of [merchant, driver, accountant]) {
      await api(user).post(`/v1/admin/pickup-zone-requests/${id}/approve`).expect(403);
    }
    await api(merchant).get('/v1/admin/pickup-zone-requests').expect(403);
    const queue = (await api(ops).get('/v1/admin/pickup-zone-requests').expect(200))
      .body as PickupZoneRequestItem[];
    expect(queue.map((item) => item.id)).toEqual([id]);

    const approved = await api(ops)
      .post(`/v1/admin/pickup-zone-requests/${id}/approve`, { note: 'Moved warehouse' })
      .expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', decidedBy: { id: ops.id } });
    await api(admin).post(`/v1/admin/pickup-zone-requests/${id}/reject`).expect(409);

    expect((await quote(merchant, { destinationZoneId: hebron })).body.finalFee).toBe('35.00');
    const me = await api(merchant).get('/v1/auth/me').expect(200);
    expect(me.body.user.merchant.pickupZoneId).toBe(nablus);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          action: { in: ['PICKUP_ZONE_CHANGE_REQUESTED', 'PICKUP_ZONE_CHANGE_APPROVED'] },
          targetUserId: merchant.id,
        },
      }),
    ).toBe(2);
  });

  it('ignores an origin chosen by the merchant on quotes and shipments', async () => {
    const priced = await quote(merchant, { destinationZoneId: hebron, originZoneId: nablus });
    expect(priced.body).toMatchObject({ finalFee: '20.00' });
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: hebron,
        originZoneId: nablus,
        addressLine: 'Street 1',
        codAmount: '0',
      })
      .expect(201);
    expect(created.body.deliveryFee).toBe('20.00');
    const shipment = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(shipment.originZoneId).toBe(ramallah);
    // Staff may still price from another origin explicitly.
    const staffQuote = await api(ops)
      .post('/v1/admin/pricing/quote', {
        merchantId: merchant.id,
        originZoneId: nablus,
        destinationZoneId: hebron,
      })
      .expect(200);
    expect(staffQuote.body.finalFee).toBe('35.00');
  });

  it('rejects with a note, replaces and withdraws requests, one pending at a time', async () => {
    const first = (await requestZone(merchant, nablus).expect(202)).body as MerchantPickupZoneState;
    const second = (await requestZone(merchant, hebron).expect(202))
      .body as MerchantPickupZoneState;
    expect(second.pending?.requestedZoneId).toBe(hebron);
    const replaced = await ctx.prisma.pickupZoneRequest.findUniqueOrThrow({
      where: { id: first.pending!.id },
    });
    expect(replaced.status).toBe('WITHDRAWN');

    const rejected = await api(ops)
      .post(`/v1/admin/pickup-zone-requests/${second.pending!.id}/reject`, {
        note: 'Pickup from Hebron is not offered yet',
      })
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');
    const state = (await api(merchant).get('/v1/merchant/pickup-zone').expect(200))
      .body as MerchantPickupZoneState;
    expect(state).toMatchObject({
      approvedZoneId: ramallah,
      pending: null,
      lastDecision: { status: 'REJECTED', decisionNote: 'Pickup from Hebron is not offered yet' },
    });

    // Asking for the zone already approved is not a change.
    expect((await requestZone(merchant, ramallah).expect(400)).body.fieldErrors).toEqual({
      zoneId: 'validation.zone.unchanged',
    });
    await requestZone(merchant, nablus).expect(202);
    await api(merchant).delete('/v1/merchant/pickup-zone/request').expect(200);
    await api(merchant).delete('/v1/merchant/pickup-zone/request').expect(409);

    // Concurrent requests are serialised: exactly one stays pending.
    await Promise.all([requestZone(merchant, nablus), requestZone(merchant, hebron)]);
    expect(
      await ctx.prisma.pickupZoneRequest.count({
        where: { merchantId: merchant.id, status: 'PENDING' },
      }),
    ).toBe(1);
  });

  it('lets a merchant without a zone request one, and re-checks the zone on approval', async () => {
    expect(
      (await api(otherMerchant).post('/v1/merchant/pricing/quote', { destinationZoneId: hebron }))
        .body.code,
    ).toBe('ORIGIN_ZONE_REQUIRED');
    const requested = (await requestZone(otherMerchant, nablus).expect(202))
      .body as MerchantPickupZoneState;
    expect(requested).toMatchObject({ approvedZoneId: null, pending: { previousZoneId: null } });
    expect(
      (await api(otherMerchant).post('/v1/merchant/pricing/quote', { destinationZoneId: hebron }))
        .body.code,
    ).toBe('ORIGIN_ZONE_REQUIRED');

    await api(ops).patch(`/v1/admin/zones/${nablus}`, { active: false }).expect(200);
    const blocked = await api(ops)
      .post(`/v1/admin/pickup-zone-requests/${requested.pending!.id}/approve`)
      .expect(422);
    expect(blocked.body.code).toBe('ZONE_INACTIVE');
    await api(ops).patch(`/v1/admin/zones/${nablus}`, { active: true }).expect(200);
    await api(ops)
      .post(`/v1/admin/pickup-zone-requests/${requested.pending!.id}/approve`)
      .expect(200);
    expect((await quote(otherMerchant, { destinationZoneId: hebron })).body.finalFee).toBe('35.00');
  });

  it('enforces the request rules in the database', async () => {
    const requested = (await requestZone(merchant, nablus).expect(202))
      .body as MerchantPickupZoneState;
    // A second pending row for the same merchant.
    await expect(
      ctx.prisma.pickupZoneRequest.create({
        data: { merchantId: merchant.id, requestedZoneId: hebron },
      }),
    ).rejects.toThrow();
    // A merchant deciding their own request.
    await expect(
      ctx.prisma.pickupZoneRequest.update({
        where: { id: requested.pending!.id },
        data: { status: 'APPROVED', decidedById: merchant.id, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/pickup_zone_requests_decider_not_merchant/);
    // Approved without a staff decider.
    await expect(
      ctx.prisma.pickupZoneRequest.update({
        where: { id: requested.pending!.id },
        data: { status: 'APPROVED', decidedAt: new Date() },
      }),
    ).rejects.toThrow(/pickup_zone_requests_staff_decision/);
  });
});
