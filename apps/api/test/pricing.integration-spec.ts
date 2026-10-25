import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server as App } from 'node:http';
import type { PricingQuote, ShipmentDetails, ZoneItem } from '@coobra/shared';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  zoneId,
  type TestContext,
  type TestUser,
} from './helpers.js';

const recipient = {
  recipientName: 'Ahmad Khalil',
  recipientPhone: '0599123456',
  addressLine: 'Main street 5',
  codAmount: '100',
};

describe('Zones and pricing (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let merchantA: TestUser;
  let merchantB: TestUser;
  let driver: TestUser;
  let ramallah: string;
  let nablus: string;
  let gaza: string;
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
    patch: (path: string, body: object = {}) =>
      request(server()).patch(path).set('authorization', `Bearer ${user.token}`).send(body),
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
    merchantA = await createSignedInUser(ctx, 'MERCHANT', 'a@example.com');
    merchantB = await createSignedInUser(ctx, 'MERCHANT', 'b@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    ramallah = await zoneId(ctx.prisma, 'RAMALLAH_ALBIREH');
    nablus = await zoneId(ctx.prisma, 'NABLUS');
    gaza = await zoneId(ctx.prisma, 'GAZA');
    await api(merchantA).put('/v1/merchant/pickup-zone', { zoneId: ramallah }).expect(204);
    await api(ops)
      .put(`/v1/admin/merchants/${merchantB.id}/pickup-zone`, { zoneId: ramallah })
      .expect(204);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  async function rule(body: object, by = accountant) {
    const res = await api(by).post('/v1/admin/pricing-rules', body).expect(201);
    return res.body.id as string;
  }

  async function cityUnder(parentId: string, code: string) {
    const kinds = await api(ops).get('/v1/admin/zone-kinds').expect(200);
    const city = kinds.body.find((kind: { code: string }) => kind.code === 'CITY');
    const res = await api(ops)
      .post('/v1/admin/zones', { code, kindId: city.id, parentId, nameAr: code, nameEn: code })
      .expect(201);
    return res.body as ZoneItem;
  }

  const quote = (merchant: TestUser, destinationZoneId: string) =>
    api(merchant).post('/v1/merchant/pricing/quote', { destinationZoneId });

  it('prices an exact route, inherits it for child zones and prefers deeper rules', async () => {
    await rule({ originZoneId: ramallah, destinationZoneId: nablus, deliveryFee: '25' });
    const res = await quote(merchantA, nablus).expect(200);
    expect(res.body as PricingQuote).toMatchObject({
      source: 'GENERAL_ROUTE',
      merchantSpecific: false,
      baseFee: '25.00',
      finalFee: '25.00',
      currency: 'ILS',
      origin: { code: 'RAMALLAH_ALBIREH' },
      destination: { code: 'NABLUS' },
      returnFee: null,
    });
    expect(res.body.quoteId).toEqual(expect.any(String));
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const town = await cityUnder(nablus, 'NABLUS_CITY');
    const inherited = await quote(merchantA, town.id).expect(200);
    expect(inherited.body).toMatchObject({
      finalFee: '25.00',
      destination: { pathEn: 'Nablus / NABLUS_CITY' },
    });

    await rule({ originZoneId: ramallah, destinationZoneId: town.id, deliveryFee: '22' });
    expect((await quote(merchantA, town.id).expect(200)).body.finalFee).toBe('22.00');
    // Higher priority wins between equally specific rules.
    await rule({
      originZoneId: ramallah,
      destinationZoneId: nablus,
      deliveryFee: '24',
      priority: 5,
    });
    expect((await quote(merchantA, nablus).expect(200)).body.finalFee).toBe('24.00');
  });

  it('applies merchant-specific rules before general rules, and fallbacks last', async () => {
    await rule({ originZoneId: ramallah, destinationZoneId: nablus, deliveryFee: '25' });
    await rule({
      merchantId: merchantA.id,
      originZoneId: ramallah,
      destinationZoneId: nablus,
      deliveryFee: '18',
    });
    expect((await quote(merchantA, nablus).expect(200)).body).toMatchObject({
      source: 'MERCHANT_ROUTE',
      merchantSpecific: true,
      finalFee: '18.00',
    });
    expect((await quote(merchantB, nablus).expect(200)).body.finalFee).toBe('25.00');

    // No rule for Gaza yet: never invent a price.
    const none = await quote(merchantA, gaza).expect(422);
    expect(none.body.code).toBe('PRICING_UNAVAILABLE');

    await rule({ isFallback: true, deliveryFee: '40' });
    expect((await quote(merchantA, gaza).expect(200)).body).toMatchObject({
      source: 'GENERAL_FALLBACK',
      finalFee: '40.00',
    });
    await rule({ merchantId: merchantA.id, isFallback: true, deliveryFee: '35' });
    expect((await quote(merchantA, gaza).expect(200)).body.source).toBe('MERCHANT_FALLBACK');
    expect((await quote(merchantB, gaza).expect(200)).body.source).toBe('GENERAL_FALLBACK');
    // A route rule still beats any fallback.
    expect((await quote(merchantA, nablus).expect(200)).body.finalFee).toBe('18.00');

    // Fallbacks cannot carry zones; route rules need both zones.
    await api(accountant)
      .post('/v1/admin/pricing-rules', {
        isFallback: true,
        originZoneId: ramallah,
        deliveryFee: '1',
      })
      .expect(400);
    await api(accountant)
      .post('/v1/admin/pricing-rules', { originZoneId: ramallah, deliveryFee: '1' })
      .expect(400);
  });

  it('rejects unknown and inactive zones and requires a pickup zone', async () => {
    await rule({ isFallback: true, deliveryFee: '30' });
    expect((await quote(merchantA, randomUUID()).expect(422)).body.code).toBe('ZONE_INVALID');

    const town = await cityUnder(nablus, 'NABLUS_TOWN');
    await api(ops).patch(`/v1/admin/zones/${nablus}`, { active: false }).expect(200);
    expect((await quote(merchantA, nablus).expect(422)).body.code).toBe('ZONE_INACTIVE');
    // A child of an inactive zone is not usable either, and is hidden from the public list.
    expect((await quote(merchantA, town.id).expect(422)).body.code).toBe('ZONE_INACTIVE');
    const visible = await api(merchantA).get('/v1/zones').expect(200);
    expect(visible.body.map((zone: ZoneItem) => zone.id)).not.toContain(town.id);
    await api(ops).patch(`/v1/admin/zones/${nablus}`, { active: true }).expect(200);

    const noPickup = await createSignedInUser(ctx, 'MERCHANT', 'c@example.com');
    expect((await quote(noPickup, nablus).expect(422)).body.code).toBe('ORIGIN_ZONE_REQUIRED');
  });

  it('makes quotes single-use, time-limited and invalid after a rule change', async () => {
    const ruleId = await rule({
      originZoneId: ramallah,
      destinationZoneId: nablus,
      deliveryFee: '25',
    });
    const create = (merchant: TestUser, quoteId: string, destinationZoneId = nablus) =>
      api(merchant).post('/v1/merchant/shipments', { ...recipient, destinationZoneId, quoteId });

    const q1 = (await quote(merchantA, nablus).expect(200)).body as PricingQuote;
    const created = await create(merchantA, q1.quoteId!).expect(201);
    expect(created.body.deliveryFee).toBe('25.00');
    expect((await create(merchantA, q1.quoteId!).expect(409)).body.code).toBe('QUOTE_INVALID');

    const q2 = (await quote(merchantA, nablus).expect(200)).body as PricingQuote;
    expect((await create(merchantB, q2.quoteId!).expect(409)).body.code).toBe('QUOTE_INVALID');
    expect((await create(merchantA, q2.quoteId!, ramallah).expect(409)).body.code).toBe(
      'QUOTE_INVALID',
    );

    await ctx.prisma.pricingQuote.update({
      where: { id: q2.quoteId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await create(merchantA, q2.quoteId!).expect(409)).body.code).toBe('QUOTE_INVALID');

    const q3 = (await quote(merchantA, nablus).expect(200)).body as PricingQuote;
    await api(accountant)
      .post(`/v1/admin/pricing-rules/${ruleId}/revise`, { deliveryFee: '30' })
      .expect(201);
    expect((await create(merchantA, q3.quoteId!).expect(409)).body.code).toBe('PRICE_CHANGED');
    // The failed attempt did not consume the quote's shipment slot or create a shipment.
    expect(await ctx.prisma.shipment.count()).toBe(1);
  });

  it('preserves historical fees when rules change', async () => {
    const ruleId = await rule({
      originZoneId: ramallah,
      destinationZoneId: nablus,
      deliveryFee: '25',
      returnFee: '12',
    });
    const res = await api(merchantA)
      .post('/v1/merchant/shipments', { ...recipient, destinationZoneId: nablus })
      .expect(201);
    const shipment = res.body as ShipmentDetails;
    expect(shipment.pricing).toMatchObject({
      source: 'GENERAL_ROUTE',
      ruleId,
      ruleVersion: 1,
      baseFee: '25.00',
      finalFee: '25.00',
      returnFee: '12.00',
    });
    expect(shipment.destination).toMatchObject({ code: 'NABLUS' });
    expect(shipment.governorate).toBe('NABLUS');

    const revised = await api(accountant)
      .post(`/v1/admin/pricing-rules/${ruleId}/revise`, { deliveryFee: '30', returnFee: '15' })
      .expect(201);
    const after = await api(merchantA).get(`/v1/merchant/shipments/${shipment.id}`).expect(200);
    expect(after.body).toMatchObject({
      deliveryFee: '25.00',
      pricing: { ruleVersion: 1, finalFee: '25.00' },
    });
    expect((await quote(merchantA, nablus).expect(200)).body).toMatchObject({
      ruleId: revised.body.id,
      ruleVersion: 2,
      finalFee: '30.00',
    });
    const rules = await api(viewer).get('/v1/admin/pricing-rules?includeInactive=true').expect(200);
    expect(
      rules.body.filter(
        (r: { ruleGroupId: string }) => r.ruleGroupId === rules.body[0].ruleGroupId,
      ),
    ).toHaveLength(2);
    // Only the active version can be revised.
    await api(accountant)
      .post(`/v1/admin/pricing-rules/${ruleId}/revise`, { deliveryFee: '31' })
      .expect(409);
  });

  it('lets SUPER_ADMIN and OPERATIONS override fees with a reason, before delivery only', async () => {
    await rule({ originZoneId: ramallah, destinationZoneId: nablus, deliveryFee: '25' });
    const res = await api(merchantA)
      .post('/v1/merchant/shipments', { ...recipient, destinationZoneId: nablus })
      .expect(201);
    const id = res.body.id as string;
    const override = (user: TestUser, body: object) =>
      api(user).post(`/v1/admin/shipments/${id}/fee-override`, body);

    await override(ops, { fee: '20' }).expect(400);
    await override(ops, { fee: '20', reason: 'Loyal customer discount' }).expect(204);
    for (const user of [merchantA, driver, accountant, viewer]) {
      await override(user, { fee: '1', reason: 'Not allowed' }).expect(403);
    }
    await api(merchantA)
      .post(`/v1/merchant/shipments/${id}/fee-override`, { fee: '1', reason: 'x' })
      .expect(404);

    const details = (await api(admin).get(`/v1/admin/shipments/${id}`).expect(200))
      .body as ShipmentDetails;
    expect(details.deliveryFee).toBe('20.00');
    expect(details.pricing).toMatchObject({ baseFee: '25.00', finalFee: '25.00' });
    expect(details.pricing?.overrides).toEqual([
      expect.objectContaining({
        phase: 'PRE_DELIVERY',
        status: 'APPLIED',
        previousFee: '25.00',
        newFee: '20.00',
        reason: 'Loyal customer discount',
        actor: expect.objectContaining({ id: ops.id, role: 'OPERATIONS' }),
      }),
    ]);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'SHIPMENT_FEE_OVERRIDDEN' },
    });
    expect(audit.actorUserId).toBe(ops.id);

    // Deliver it; a direct override is then refused (corrections go through finance).
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    await api(driver)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: true, amount: '100', confirmed: true },
      })
      .expect(200);
    expect((await override(admin, { fee: '10', reason: 'Too late' }).expect(409)).body.code).toBe(
      'FEE_OVERRIDE_NOT_ALLOWED',
    );
  });

  it('lets staff price manually with a reason when no rule exists', async () => {
    const base = { ...recipient, merchantId: merchantA.id, destinationZoneId: gaza };
    expect((await api(ops).post('/v1/admin/shipments', base).expect(422)).body.code).toBe(
      'PRICING_UNAVAILABLE',
    );
    const res = await api(ops)
      .post('/v1/admin/shipments', {
        ...base,
        manualFee: '45',
        manualFeeReason: 'New route, agreed by phone',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      deliveryFee: '45.00',
      pricing: { source: 'MANUAL', baseFee: null, finalFee: '45.00' },
    });
    expect(res.body.pricing.overrides[0]).toMatchObject({ previousFee: null, newFee: '45.00' });
    // Merchants are refused instead.
    const refused = await api(merchantA)
      .post('/v1/merchant/shipments', { ...recipient, destinationZoneId: gaza })
      .expect(422);
    expect(refused.body.code).toBe('PRICING_UNAVAILABLE');
  });

  it('restricts zone and pricing management by role', async () => {
    const kinds = (await api(viewer).get('/v1/admin/zone-kinds').expect(200)).body;
    const kindId = kinds[0].id;
    const zone = { code: 'NEW_AREA', kindId, nameAr: 'منطقة', nameEn: 'Area' };
    await api(accountant).post('/v1/admin/zones', zone).expect(403);
    await api(viewer).post('/v1/admin/zones', zone).expect(403);
    await api(merchantA).post('/v1/admin/zones', zone).expect(403);
    await api(admin).post('/v1/admin/zones', zone).expect(201);
    expect((await api(ops).post('/v1/admin/zones', zone).expect(400)).body.fieldErrors).toEqual({
      code: 'validation.zone.codeTaken',
    });

    const body = { originZoneId: ramallah, destinationZoneId: nablus, deliveryFee: '25' };
    await api(ops).post('/v1/admin/pricing-rules', body).expect(403);
    await api(viewer).post('/v1/admin/pricing-rules', body).expect(403);
    await api(merchantA).post('/v1/admin/pricing-rules', body).expect(403);
    await api(admin).post('/v1/admin/pricing-rules', body).expect(201);
    await api(viewer).get('/v1/admin/pricing-rules').expect(200);
    await api(driver).get('/v1/admin/pricing-rules').expect(403);
    await api(driver).get('/v1/zones').expect(200);
    await api(merchantA)
      .put(`/v1/admin/merchants/${merchantB.id}/pickup-zone`, { zoneId: nablus })
      .expect(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'PRICING_RULE_CREATED' } })).toBe(1);
  });
});
