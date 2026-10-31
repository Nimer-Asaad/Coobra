import request from 'supertest';
import type { Server as App } from 'node:http';
import type { ShipmentDetails } from '@coobra/shared';
import { generateOpaqueToken, hashToken } from '../src/auth/token.util.js';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  setupBasicPricing,
  type TestContext,
  type TestUser,
} from './helpers.js';

/*
 * Phase 4C.2: requests carry an ActingContext (real actor, effective principal, impersonation).
 * Outside impersonation the actor and the principal are the same person, so every record keeps
 * exactly the attribution it had before. Impersonation is not enabled: a session created by an
 * impersonation never authenticates.
 */

describe('Acting context (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let merchant: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: { token: string }) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
  });
  const shipmentInput = () => ({
    recipientName: 'Ahmad Khalil',
    recipientPhone: '0599123456',
    city: 'Al-Bireh',
    addressLine: 'Al-Quds street, building 5',
    codAmount: '150',
    destinationZoneId: zones.ramallah,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'merchant@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'driver@example.com');
    zones = await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx?.app.close();
  });

  async function auditFor(shipmentId: string, action: string) {
    return ctx.prisma.auditLog.findFirstOrThrow({
      where: { action, metadata: { path: ['shipmentId'], equals: shipmentId } },
    });
  }

  it('records the merchant as creator, pricer and actor of a shipment they create', async () => {
    const quote = await api(merchant)
      .post('/v1/merchant/pricing/quote', { destinationZoneId: zones.ramallah })
      .expect(200);
    const created = (
      await api(merchant)
        .post('/v1/merchant/shipments', { ...shipmentInput(), quoteId: quote.body.quoteId })
        .expect(201)
    ).body as ShipmentDetails;

    const row = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { id: created.id },
      include: { pricing: true, history: true, pricingQuote: true },
    });
    expect(row).toMatchObject({
      merchantId: merchant.id,
      createdById: merchant.id,
      creatorRole: 'MERCHANT',
      createdImpersonationId: null,
    });
    expect(row.pricing?.pricedById).toBe(merchant.id);
    expect(row.pricingQuote).toMatchObject({ createdById: merchant.id, impersonationId: null });
    expect(row.history.map((h) => [h.actorUserId, h.actorRole, h.impersonationId])).toEqual([
      [merchant.id, 'MERCHANT', null],
    ]);
    expect(await auditFor(created.id, 'SHIPMENT_CREATED')).toMatchObject({
      actorUserId: merchant.id,
      targetUserId: merchant.id,
      effectiveUserId: null,
      impersonationId: null,
    });
  });

  it('records staff as creator of a shipment made on behalf of a merchant (unchanged)', async () => {
    const created = (
      await api(ops)
        .post('/v1/admin/shipments', { ...shipmentInput(), merchantId: merchant.id })
        .expect(201)
    ).body as ShipmentDetails;
    const row = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      merchantId: merchant.id,
      createdById: ops.id,
      creatorRole: 'OPERATIONS',
    });
    expect(await auditFor(created.id, 'SHIPMENT_CREATED')).toMatchObject({
      actorUserId: ops.id,
      targetUserId: merchant.id,
      effectiveUserId: null,
    });
  });

  it('records the driver on every transition, the COD collection and both postings', async () => {
    const created = (
      await api(merchant).post('/v1/merchant/shipments', shipmentInput()).expect(201)
    ).body as ShipmentDetails;
    await api(ops)
      .post(`/v1/admin/shipments/${created.id}/assign`, { driverId: driver.id })
      .expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver)
        .post(`/v1/driver/shipments/${created.id}/transitions`, { toStatus })
        .expect(200);
    }
    await api(driver)
      .post(`/v1/driver/shipments/${created.id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: true, amount: '150', confirmed: true },
      })
      .expect(200);

    const shipment = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { id: created.id },
      include: { history: { orderBy: { createdAt: 'asc' } }, codCollections: true },
    });
    expect(shipment.deliveredById).toBe(driver.id);
    const driverSteps = shipment.history.filter((h) => h.actorRole === 'DRIVER');
    expect(driverSteps.map((h) => h.toStatus)).toEqual([
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    expect(
      driverSteps.every((h) => h.actorUserId === driver.id && h.impersonationId === null),
    ).toBe(true);
    expect(shipment.codCollections.map((c) => c.driverId)).toEqual([driver.id]);
    const postings = await ctx.prisma.journalEntry.findMany({
      where: { lines: { some: { shipmentId: created.id } } },
      select: { kind: true, createdById: true },
      orderBy: { kind: 'asc' },
    });
    expect(postings).toEqual([
      { kind: 'COD_COLLECTION', createdById: driver.id },
      { kind: 'DELIVERY_FEE', createdById: driver.id },
    ]);
  });

  it('keeps each account scoped to its own shipments', async () => {
    const other = await createSignedInUser(ctx, 'MERCHANT', 'other@example.com');
    await setupBasicPricing(ctx.prisma, [other.id]);
    const mine = (await api(merchant).post('/v1/merchant/shipments', shipmentInput()).expect(201))
      .body as ShipmentDetails;
    await api(other).get(`/v1/merchant/shipments/${mine.id}`).expect(404);
    await api(driver).get(`/v1/driver/shipments/${mine.id}`).expect(404);
    const list = await api(merchant).get('/v1/merchant/shipments').expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([mine.id]);
  });

  it('never authenticates a session that belongs to an impersonation', async () => {
    const adminSession = await ctx.prisma.session.findFirstOrThrow({ where: { userId: admin.id } });
    const startedAt = new Date();
    const imp = await ctx.prisma.impersonationSession.create({
      data: {
        actorUserId: admin.id,
        actorSessionId: adminSession.id,
        targetUserId: merchant.id,
        targetRole: 'MERCHANT',
        clientApp: 'MERCHANT_APP',
        reason: 'Phase 4C.2 test: impersonation must stay disabled',
        activeActorId: admin.id,
        activeTargetId: merchant.id,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 30 * 60_000),
      },
    });
    const token = generateOpaqueToken();
    await ctx.prisma.session.create({
      data: {
        userId: merchant.id,
        clientApp: 'MERCHANT_APP',
        tokenHash: hashToken(token),
        expiresAt: imp.expiresAt,
        impersonationId: imp.id,
      },
    });
    const body = (await api({ token }).get('/v1/auth/me').expect(401)).body;
    expect(body.code).toBe('UNAUTHENTICATED');
    await api({ token }).get('/v1/merchant/shipments').expect(401);
    await api({ token }).post('/v1/merchant/shipments', shipmentInput()).expect(401);
    // The merchant's own session is unaffected.
    await api(merchant).get('/v1/auth/me').expect(200);
    expect(await ctx.prisma.shipment.count()).toBe(0);
  });
});
