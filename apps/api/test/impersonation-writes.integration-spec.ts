import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server as App } from 'node:http';
import {
  IMPERSONATION_HEADER,
  IMPERSONATION_ROUTE_POLICY,
  type AdjustmentItem,
  type AdjustmentReview,
  type ConsequencePreview,
  type ReviewEligibility,
} from '@coobra/shared';
import { AuditService } from '../src/audit/audit.service.js';
import { CLOCK, type Clock } from '../src/common/clock.js';
import { ApprovalService } from '../src/finance/approval.service.js';
import { endImpersonationIn } from '../src/impersonation/impersonation-records.js';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  setupBasicPricing,
  TEST_PASSWORD,
  type TestContext,
  type TestUser,
} from './helpers.js';

/*
 * Phase 4C.4: impersonated operational writes (ADR 0003 §4, §10). Enabled explicitly in this
 * isolated test app only (IMPERSONATION_WRITES_ENABLED defaults to false everywhere).
 */

const MERCHANT_ORIGIN = 'http://localhost:8082';
const DRIVER_ORIGIN = 'http://localhost:8081';
const MINUTE = 60_000;
// Test-only key ring (a random secret per test run; never a real key).
const SIGNING = {
  IMPERSONATION_WRITES_ENABLED: 'true',
  CONSEQUENCE_SIGNING_KEYS: `test1:${randomBytes(32).toString('base64url')}`,
  CONSEQUENCE_SIGNING_ACTIVE_KEY: 'test1',
};

describe('Impersonated writes (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let clock: Clock;
  let admin: TestUser;
  let otherAdmin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let merchant: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  let offsetMs = 0;
  const server = () => ctx.app.getHttpServer() as App;
  const bearer = (user: { token: string }) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(path)
        .set('authorization', `Bearer ${user.token}`)
        .set('idempotency-key', randomUUID())
        .send(body),
  });
  const tab = (cookie: string, origin: string) => ({
    get: (path: string) =>
      request(server())
        .get(path)
        .set('cookie', cookie)
        .set(IMPERSONATION_HEADER, '1')
        .set('origin', origin),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(path)
        .set('cookie', cookie)
        .set(IMPERSONATION_HEADER, '1')
        .set('origin', origin)
        .send(body),
  });

  async function impersonate(target: TestUser, actor = admin) {
    await bearer(actor).post('/v1/auth/reauthenticate', { password: TEST_PASSWORD }).expect(204);
    const verifier = randomBytes(32).toString('base64url');
    const started = await bearer(actor)
      .post('/v1/admin/impersonations', {
        targetUserId: target.id,
        reason: 'Customer asked for help',
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      })
      .expect(201);
    const origin = target.role === 'DRIVER' ? DRIVER_ORIGIN : MERCHANT_ORIGIN;
    const res = await request(server())
      .post('/v1/auth/impersonation/exchange')
      .set(IMPERSONATION_HEADER, '1')
      .set('origin', origin)
      .send({ code: started.body.code, codeVerifier: verifier })
      .expect(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('coobra_imp_session='))!
      .split(';')[0]!;
    return { id: started.body.impersonation.id as string, cookie, as: tab(cookie, origin) };
  }

  const shipmentInput = () => ({
    recipientName: 'Ahmad Khalil',
    recipientPhone: '0599123456',
    city: 'Al-Bireh',
    addressLine: 'Main street',
    codAmount: '100',
    destinationZoneId: zones.ramallah,
  });

  async function previewCreate(as: ReturnType<typeof tab>, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({
      destinationZoneId: zones.ramallah,
      codAmount: '100',
      ...extra,
    });
    const res = await as.get(`/v1/merchant/shipment-consequences?${query}`).expect(200);
    return res.body as ConsequencePreview;
  }

  async function previewTransition(
    as: ReturnType<typeof tab>,
    app: 'merchant' | 'driver',
    id: string,
    toStatus: string,
  ) {
    const res = await as
      .get(`/v1/${app}/shipments/${id}/consequences?toStatus=${toStatus}`)
      .expect(200);
    return res.body as ConsequencePreview;
  }

  /** A merchant shipment assigned to the driver and out for delivery (by the real users). */
  async function outForDelivery() {
    const created = await bearer(merchant)
      .post('/v1/merchant/shipments', shipmentInput())
      .expect(201);
    const id = created.body.id as string;
    await bearer(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await bearer(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    return id;
  }

  async function moneySnapshot() {
    const counts: Record<string, number> = {};
    for (const table of [
      'journal_entries',
      'journal_lines',
      'cod_collections',
      'cod_shortfalls',
      'merchant_payouts',
      'merchant_payments',
      'driver_settlements',
      'driver_cash_shortages',
      'driver_repayments',
      'financial_adjustments',
    ]) {
      const rows = await ctx.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table}`,
      );
      counts[table] = Number(rows[0]!.n);
    }
    return counts;
  }

  beforeAll(async () => {
    ctx = await createTestApp(SIGNING);
    clock = ctx.app.get<Clock>(CLOCK);
    vi.spyOn(clock, 'now').mockImplementation(() => new Date(Date.now() + offsetMs));
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    otherAdmin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin2@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'accountant@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'merchant@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'driver@example.com');
    zones = await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await resetDatabase(ctx.prisma);
    await ctx?.app.close();
  });

  describe('merchant writes', () => {
    it('creates a shipment with a confirmed fee preview and full attribution', async () => {
      const before = await moneySnapshot();
      const { id: impId, as } = await impersonate(merchant);
      const preview = await previewCreate(as);
      expect(preview.lines).toEqual([
        expect.objectContaining({
          kind: 'DELIVERY_FEE',
          amount: '15.00',
          certainty: 'FIXED',
          trigger: 'ON_DELIVERY',
        }),
        expect.objectContaining({ kind: 'COD_TO_COLLECT', amount: '100.00', certainty: 'FIXED' }),
        expect.objectContaining({
          kind: 'RETURN_FEE',
          amount: '10.00',
          certainty: 'FIXED',
          trigger: 'ON_RETURN_COMPLETED',
        }),
      ]);
      const created = await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(201);
      const row = await ctx.prisma.shipment.findUniqueOrThrow({
        where: { id: created.body.id },
        include: { history: true, pricing: true },
      });
      expect(row).toMatchObject({
        merchantId: merchant.id,
        createdById: admin.id,
        creatorRole: 'SUPER_ADMIN',
        createdImpersonationId: impId,
      });
      expect(row.pricing?.pricedById).toBe(admin.id);
      expect(row.history[0]).toMatchObject({ actorUserId: admin.id, impersonationId: impId });
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHIPMENT_CREATED' },
      });
      expect(audit).toMatchObject({
        actorUserId: admin.id,
        effectiveUserId: merchant.id,
        impersonationId: impId,
      });
      // Phase 4C.5 display contract: the tab knows writes are on, and the audit viewer shows
      // "{admin} acting as {merchant}" and filters one impersonation (its start included).
      expect((await as.get('/v1/auth/me').expect(200)).body.impersonation.writesEnabled).toBe(true);
      const viewer = await bearer(admin)
        .get(`/v1/admin/audit-logs?impersonationId=${impId}`)
        .expect(200);
      expect(viewer.body.items.map((item: { action: string }) => item.action)).toEqual(
        expect.arrayContaining(['SHIPMENT_CREATED', 'IMPERSONATION_STARTED']),
      );
      const shown = viewer.body.items.find(
        (item: { action: string }) => item.action === 'SHIPMENT_CREATED',
      );
      expect(shown).toMatchObject({
        actor: { id: admin.id },
        effectiveUser: { id: merchant.id, role: 'MERCHANT' },
        impersonationId: impId,
      });
      const detail = await bearer(admin).get(`/v1/admin/audit-logs/${shown.id}`).expect(200);
      expect(detail.body.effectiveUser).toMatchObject({ id: merchant.id });
      // The start itself was done as the admin (outside the impersonation).
      const ordinary = await bearer(admin)
        .get('/v1/admin/audit-logs?action=IMPERSONATION_STARTED')
        .expect(200);
      expect(ordinary.body.items.length).toBeGreaterThan(0);
      for (const item of ordinary.body.items) {
        expect(item).toMatchObject({ effectiveUser: null, impersonationId: null });
      }
      expect(await moneySnapshot()).toEqual(before);
    });

    it('refuses a missing, tampered or mismatched confirmation', async () => {
      const { as } = await impersonate(merchant);
      const missing = await as.post('/v1/merchant/shipments', shipmentInput()).expect(400);
      expect(missing.body.code).toBe('CONSEQUENCE_CONFIRMATION_REQUIRED');
      const preview = await previewCreate(as);
      const tampered = `${preview.confirmationToken.slice(0, -3)}AAA`;
      expect(
        (
          await as
            .post('/v1/merchant/shipments', { ...shipmentInput(), confirmationToken: tampered })
            .expect(409)
        ).body.code,
      ).toBe('CONSEQUENCE_CHANGED');
      // A token for 100 does not confirm 250.
      await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          codAmount: '250',
          confirmationToken: preview.confirmationToken,
        })
        .expect(409);
      offsetMs = 6 * MINUTE; // the confirmation is valid 5 minutes
      await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(409);
      expect(await ctx.prisma.shipment.count()).toBe(0);
    });

    it('detects a fee change between the confirmation and the write', async () => {
      const { as } = await impersonate(merchant);
      const preview = await previewCreate(as);
      await ctx.prisma.pricingRule.updateMany({
        data: { deliveryFee: '18', version: { increment: 1 } },
      });
      await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(409);
      expect(await ctx.prisma.shipment.count()).toBe(0);
    });

    it('binds quotes to the context that created them, in both directions', async () => {
      const own = await bearer(merchant)
        .post('/v1/merchant/pricing/quote', { destinationZoneId: zones.ramallah })
        .expect(200);
      const { id: impId, as } = await impersonate(merchant);
      const impQuote = await as
        .post('/v1/merchant/pricing/quote', { destinationZoneId: zones.ramallah })
        .expect(200);
      const quoteRow = await ctx.prisma.pricingQuote.findUniqueOrThrow({
        where: { id: impQuote.body.quoteId },
      });
      expect(quoteRow).toMatchObject({ createdById: admin.id, impersonationId: impId });
      // The merchant's own quote cannot be used during the impersonation...
      const foreignQuote = await as
        .get(
          `/v1/merchant/shipment-consequences?destinationZoneId=${zones.ramallah}&codAmount=100&quoteId=${own.body.quoteId}`,
        )
        .expect(409);
      expect(foreignQuote.body.code).toBe('QUOTE_INVALID');
      // ...the impersonation's quote works there...
      const preview = await previewCreate(as, { quoteId: impQuote.body.quoteId });
      await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          quoteId: impQuote.body.quoteId,
          confirmationToken: preview.confirmationToken,
        })
        .expect(201);
      // ...and an impersonation's quote is refused in the merchant's own session.
      const another = await as
        .post('/v1/merchant/pricing/quote', { destinationZoneId: zones.ramallah })
        .expect(200);
      const ownSession = await bearer(merchant)
        .post('/v1/merchant/shipments', { ...shipmentInput(), quoteId: another.body.quoteId })
        .expect(409);
      expect(ownSession.body.code).toBe('QUOTE_INVALID');
    });

    it('cancels with a reason and requests a return with its charges confirmed', async () => {
      await ctx.prisma.pricingRule.updateMany({ data: { returnPolicy: 'DELIVERY_PLUS_RETURN' } });
      const fresh = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const failed = await outForDelivery();
      await bearer(driver)
        .post(`/v1/driver/shipments/${failed}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Nobody home',
        })
        .expect(200);
      const { id: impId, as } = await impersonate(merchant);

      await as
        .post(`/v1/merchant/shipments/${fresh.body.id}/transitions`, { toStatus: 'CANCELLED' })
        .expect(400);
      await as
        .post(`/v1/merchant/shipments/${fresh.body.id}/transitions`, {
          toStatus: 'CANCELLED',
          reason: 'Customer cancelled',
        })
        .expect(200);

      const preview = await previewTransition(as, 'merchant', failed, 'RETURN_REQUESTED');
      expect(preview.lines).toEqual([
        expect.objectContaining({ kind: 'RETURN_FEE', amount: '10.00', certainty: 'FIXED' }),
        expect.objectContaining({
          kind: 'RETURN_DELIVERY_CHARGE',
          amount: '15.00',
          certainty: 'FIXED',
        }),
      ]);
      await as
        .post(`/v1/merchant/shipments/${failed}/transitions`, {
          toStatus: 'RETURN_REQUESTED',
          reason: 'Return it',
        })
        .expect(400);
      await as
        .post(`/v1/merchant/shipments/${failed}/transitions`, {
          toStatus: 'RETURN_REQUESTED',
          reason: 'Return it',
          confirmationToken: preview.confirmationToken,
        })
        .expect(200);
      const record = await ctx.prisma.returnRecord.findUniqueOrThrow({
        where: { shipmentId: failed },
      });
      expect(record).toMatchObject({
        requestedById: admin.id,
        requestedImpersonationId: impId,
        deliveryCharge: expect.anything(),
      });
      expect(record.deliveryCharge.toFixed(2)).toBe('15.00');
    });

    it('keeps every financial and settings write of the merchant forbidden', async () => {
      const before = await moneySnapshot();
      const { as } = await impersonate(merchant);
      for (const [path, body] of [
        ['/v1/merchant/finance/payouts', { amount: '10' }],
        [`/v1/merchant/finance/payouts/${randomUUID()}/cancel`, { reason: 'No' }],
        [`/v1/merchant/finance/shortfalls/${randomUUID()}/accept`, {}],
        [`/v1/merchant/finance/shortfalls/${randomUUID()}/decline`, { note: 'No' }],
      ] as [string, object][]) {
        const res = await as.post(path, body);
        expect(res.status, path).toBe(403);
        expect(res.body.code, path).toBe('IMPERSONATION_FORBIDDEN_ACTION');
      }
      expect(await moneySnapshot()).toEqual(before);
    });
  });

  describe('driver writes', () => {
    it('allows custody steps with a reason and forbids delivery, collection and settlement', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const id = created.body.id as string;
      await bearer(ops)
        .post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id })
        .expect(200);
      const before = await moneySnapshot();
      const { id: impId, as } = await impersonate(driver);
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, { toStatus: 'PICKED_UP' })
        .expect(400);
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'PICKED_UP',
          reason: 'Phone broken',
        })
        .expect(200);
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'OUT_FOR_DELIVERY',
          reason: 'Phone broken',
        })
        .expect(200);
      const delivered = await as.post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        reason: 'x',
        cod: { collected: true, amount: '100', confirmed: true },
      });
      expect(delivered.status).toBe(403);
      expect(delivered.body.code).toBe('IMPERSONATION_FORBIDDEN_ACTION');
      await as.post(`/v1/driver/shipments/${id}/collections`, { amount: '10' }).expect(403);
      await as.post('/v1/driver/finance/settlements', { declaredAmount: '10' }).expect(403);

      const preview = await previewTransition(as, 'driver', id, 'DELIVERY_FAILED');
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Nobody home',
          confirmationToken: preview.confirmationToken,
        })
        .expect(200);
      const history = await ctx.prisma.shipmentStatusHistory.findMany({
        where: { shipmentId: id, impersonationId: impId },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => [h.toStatus, h.actorUserId, h.actorRole])).toEqual([
        ['PICKED_UP', admin.id, 'SUPER_ADMIN'],
        ['OUT_FOR_DELIVERY', admin.id, 'SUPER_ADMIN'],
        ['DELIVERY_FAILED', admin.id, 'SUPER_ADMIN'],
      ]);
      const shipment = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id } });
      expect(shipment.status).toBe('DELIVERY_FAILED');
      expect(shipment.driverId).toBe(driver.id);
      expect(await moneySnapshot()).toEqual(before);
    });

    it('detects a fee change between the preview and the transition', async () => {
      const id = await outForDelivery();
      await ctx.prisma.pricingRule.updateMany({ data: { returnPolicy: 'DELIVERY_PLUS_RETURN' } });
      const { as } = await impersonate(driver);
      const preview = await previewTransition(as, 'driver', id, 'DELIVERY_FAILED');
      await ctx.prisma.shipment.update({ where: { id }, data: { deliveryFee: '20' } });
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Nobody home',
          confirmationToken: preview.confirmationToken,
        })
        .expect(409);
      expect((await ctx.prisma.shipment.findUniqueOrThrow({ where: { id } })).status).toBe(
        'OUT_FOR_DELIVERY',
      );
    });
  });

  describe('transaction safety', () => {
    it('refuses a write that waited while the impersonation was ended', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const { id: impId, as } = await impersonate(merchant);
      let write!: Promise<request.Response>;
      await ctx.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM impersonation_sessions WHERE id = ${impId}::uuid FOR UPDATE`;
        write = as
          .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
            toStatus: 'CANCELLED',
            reason: 'Racing',
          })
          .then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 300)); // the write is now waiting
        await endImpersonationIn(tx, { impersonationId: impId, reason: 'MANUAL', now: new Date() });
      });
      expect((await write).status).toBe(401);
      expect(
        (await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.body.id } })).status,
      ).toBe('CREATED');
      expect(
        await ctx.prisma.shipmentStatusHistory.count({ where: { impersonationId: impId } }),
      ).toBe(0);
    });

    it('refuses a write whose impersonation expired while it waited', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const { id: impId, as } = await impersonate(merchant);
      let write!: Promise<request.Response>;
      await ctx.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM impersonation_sessions WHERE id = ${impId}::uuid FOR UPDATE`;
        write = as
          .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
            toStatus: 'CANCELLED',
            reason: 'Racing',
          })
          .then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 300));
        offsetMs = 31 * MINUTE; // expires while the write waits for the lock
      });
      expect((await write).status).toBe(401);
      expect(
        (await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.body.id } })).status,
      ).toBe('CREATED');
    });

    it('commits a write that finished first; the end then follows it', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const { id: impId, as } = await impersonate(merchant);
      await as
        .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
          toStatus: 'CANCELLED',
          reason: 'First',
        })
        .expect(200);
      await bearer(admin).post(`/v1/admin/impersonations/${impId}/end`).expect(200);
      const history = await ctx.prisma.shipmentStatusHistory.findFirstOrThrow({
        where: { impersonationId: impId },
      });
      const ended = await ctx.prisma.impersonationSession.findUniqueOrThrow({
        where: { id: impId },
      });
      expect(history.createdAt.getTime()).toBeLessThanOrEqual(ended.endedAt!.getTime());
    });

    it('lets one of two racing transitions win and keeps deactivation deadlock-free', async () => {
      const id = await outForDelivery();
      await bearer(driver)
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Nobody home',
        })
        .expect(200);
      const { as } = await impersonate(driver);
      const race = await Promise.all(
        [1, 2].map(() =>
          as.post(`/v1/driver/shipments/${id}/transitions`, {
            toStatus: 'OUT_FOR_DELIVERY',
            reason: 'Again',
          }),
        ),
      );
      // The loser sees either the version guard (409) or the new status (400: invalid jump).
      expect(race.every((r) => [200, 400, 409].includes(r.status))).toBe(true);
      expect(race.filter((r) => r.status === 200)).toHaveLength(1);

      // A deactivation of the target racing a write: both finish, without a deadlock (500).
      const version = (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: driver.id } })
      ).updatedAt.toISOString();
      const [write, deactivation] = await Promise.all([
        as.post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Racing',
        }),
        bearer(otherAdmin).post(`/v1/admin/users/${driver.id}/deactivate`, {
          reason: 'Left',
          expectedUpdatedAt: version,
        }),
      ]);
      expect(deactivation.status).toBe(200);
      expect([200, 400, 401, 409]).toContain(write.status);
      expect(write.status).not.toBe(500);
    });

    it('rolls the whole write back when its audit entry fails', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const { id: impId, as } = await impersonate(merchant);
      const audit = ctx.app.get(AuditService);
      const original = audit.recordIn.bind(audit);
      const spy = vi.spyOn(audit, 'recordIn').mockImplementation(async (tx, entry) => {
        if (entry.action === 'SHIPMENT_CANCELLED') throw new Error('audit unavailable');
        return original(tx, entry);
      });
      try {
        await as
          .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
            toStatus: 'CANCELLED',
            reason: 'Rollback',
          })
          .expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(
        (await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.body.id } })).status,
      ).toBe('CREATED');
      expect(
        await ctx.prisma.shipmentStatusHistory.count({ where: { impersonationId: impId } }),
      ).toBe(0);
    });

    it('stays off when impersonated writes are disabled', async () => {
      const created = await bearer(merchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      const { as } = await impersonate(merchant);
      ctx.config.impersonationWrites.enabled = false;
      try {
        await as
          .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
            toStatus: 'CANCELLED',
            reason: 'Off',
          })
          .expect(403);
        await as
          .get(
            `/v1/merchant/shipment-consequences?destinationZoneId=${zones.ramallah}&codAmount=10`,
          )
          .expect(403);
        await as.get('/v1/merchant/shipments').expect(200); // reads still work
      } finally {
        ctx.config.impersonationWrites.enabled = true;
      }
    });
  });

  describe('conflict of interest (R1, §10.4)', () => {
    async function impersonatedReturnRequest() {
      const id = await outForDelivery();
      await bearer(driver)
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'DELIVERY_FAILED',
          reason: 'Nobody home',
        })
        .expect(200);
      const { id: impId, as } = await impersonate(merchant);
      const preview = await previewTransition(as, 'merchant', id, 'RETURN_REQUESTED');
      await as
        .post(`/v1/merchant/shipments/${id}/transitions`, {
          toStatus: 'RETURN_REQUESTED',
          reason: 'Return it',
          confirmationToken: preview.confirmationToken,
        })
        .expect(200);
      await bearer(admin).post(`/v1/admin/impersonations/${impId}/end`).expect(200);
      return id;
    }

    it('keeps the involved admin from every decision on that shipment, also long after the end', async () => {
      const id = await impersonatedReturnRequest();
      offsetMs = 24 * 60 * MINUTE;
      const refusals = [
        bearer(admin).post(`/v1/admin/shipments/${id}/return/approve`, {}),
        bearer(admin).post(`/v1/admin/returns/${id}/fee`, { amount: '5', reason: 'Lower fee' }),
        bearer(admin).post(`/v1/admin/returns/${id}/waive`, { reason: 'Goodwill' }),
        bearer(admin).post(`/v1/admin/shipments/${id}/transitions`, { toStatus: 'RETURNED' }),
      ];
      for (const res of await Promise.all(refusals)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IMPERSONATION_CONFLICT');
      }
      // Another staff member decides normally.
      await bearer(otherAdmin).post(`/v1/admin/shipments/${id}/return/approve`, {}).expect(200);
    });

    it('refuses the involved admin a fee override on a shipment created while impersonating', async () => {
      const { as, id: impId } = await impersonate(merchant);
      const preview = await previewCreate(as);
      const created = await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(201);
      await bearer(admin).post(`/v1/admin/impersonations/${impId}/end`).expect(200);
      const res = await bearer(admin).post(`/v1/admin/shipments/${created.body.id}/fee-override`, {
        fee: '12',
        reason: 'Discount',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_CONFLICT');
      await bearer(ops)
        .post(`/v1/admin/shipments/${created.body.id}/fee-override`, {
          fee: '12',
          reason: 'Discount',
        })
        .expect(204);
      expect(
        (
          await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.body.id } })
        ).deliveryFee?.toFixed(2),
      ).toBe('12.00');
    });

    it('requires an independent reviewer for adjustments (linked and UNLINKED)', async () => {
      const { as, id: impId } = await impersonate(merchant);
      const preview = await previewCreate(as);
      const created = await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(201);
      await bearer(admin).post(`/v1/admin/impersonations/${impId}/end`).expect(200);
      const ask = (body: object) =>
        bearer(accountant).post('/v1/admin/finance/adjustments', {
          type: 'MERCHANT_CREDIT',
          merchantId: merchant.id,
          amount: '5',
          reason: 'Goodwill credit',
          ...body,
        });
      // Provenance must be this merchant's.
      const otherMerchant = await createSignedInUser(ctx, 'MERCHANT', 'other@example.com');
      await setupBasicPricing(ctx.prisma, [otherMerchant.id]);
      const foreign = await bearer(otherMerchant)
        .post('/v1/merchant/shipments', shipmentInput())
        .expect(201);
      expect(
        (await ask({ sourceType: 'SHIPMENT_FEE', sourceShipmentId: foreign.body.id }).expect(400))
          .body.fieldErrors,
      ).toEqual({
        sourceType: 'validation.finance.adjustmentSource',
      });

      const linked = await ask({
        sourceType: 'SHIPMENT_FEE',
        sourceShipmentId: created.body.id,
      }).expect(201);
      const unlinked = await ask({}).expect(201);
      // Phase 4C.5: reviewers see what each adjustment is linked to.
      expect(linked.body).toMatchObject({
        sourceType: 'SHIPMENT_FEE',
        sourceShipment: { id: created.body.id, trackingNumber: created.body.trackingNumber },
        sourceJournalEntryId: null,
      });
      expect(unlinked.body).toMatchObject({ sourceType: 'UNLINKED', sourceShipment: null });
      const listed = await bearer(accountant).get('/v1/admin/finance/adjustments').expect(200);
      expect(
        listed.body.find((item: { id: string }) => item.id === linked.body.id).sourceShipment,
      ).toEqual({ id: created.body.id, trackingNumber: created.body.trackingNumber });
      for (const adjustment of [linked.body, unlinked.body]) {
        const res = await bearer(admin).post(
          `/v1/admin/finance/adjustments/${adjustment.id}/approve`,
          {},
        );
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IMPERSONATION_CONFLICT');
        const rejected = await bearer(admin).post(
          `/v1/admin/finance/adjustments/${adjustment.id}/reject`,
          { note: 'Not justified' },
        );
        expect(rejected.status).toBe(403);
      }
      // The requester still cannot approve their own (maker-checker unchanged)...
      expect(
        (
          await bearer(accountant).post(
            `/v1/admin/finance/adjustments/${unlinked.body.id}/approve`,
            {},
          )
        ).body.code,
      ).toBe('SELF_APPROVAL_FORBIDDEN');
      // ...and an independent reviewer can.
      await bearer(otherAdmin)
        .post(`/v1/admin/finance/adjustments/${linked.body.id}/approve`, {})
        .expect(200);
      await bearer(otherAdmin)
        .post(`/v1/admin/finance/adjustments/${unlinked.body.id}/approve`, {})
        .expect(200);
    });

    it('tells each reviewer in advance whether they may decide, and still checks the decision', async () => {
      // The admin acted as the merchant (and created a shipment as them), then ended it.
      const { as, id: impId } = await impersonate(merchant);
      const preview = await previewCreate(as);
      const shipment = await as
        .post('/v1/merchant/shipments', {
          ...shipmentInput(),
          confirmationToken: preview.confirmationToken,
        })
        .expect(201);
      await bearer(admin).post(`/v1/admin/impersonations/${impId}/end`).expect(200);
      const accountant2 = await createSignedInUser(ctx, 'ACCOUNTANT', 'accountant2@example.com');
      const owner = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
      const ask = async (amount: string, body: object = {}) =>
        (
          await bearer(accountant)
            .post('/v1/admin/finance/adjustments', {
              type: 'MERCHANT_CREDIT',
              merchantId: merchant.id,
              amount,
              reason: 'Goodwill credit',
              ...body,
            })
            .expect(201)
        ).body.id as string;
      const small = await ask('5'); // UNLINKED
      const large = await ask('500'); // UNLINKED, above the 200.00 approval threshold
      const linked = await ask('5', {
        sourceType: 'SHIPMENT_FEE',
        sourceShipmentId: shipment.body.id,
      });
      const reviewOf = async (user: TestUser) => {
        const res = await bearer(user).get('/v1/admin/finance/adjustments').expect(200);
        return Object.fromEntries(
          (res.body as AdjustmentItem[]).map((item) => [item.id, item.review]),
        ) as Record<string, AdjustmentReview | null>;
      };
      const allowed: ReviewEligibility = { allowed: true, reason: null };
      const refused = (reason: ReviewEligibility['reason']) => ({ allowed: false, reason });
      const both = (eligibility: ReviewEligibility) => ({
        approve: eligibility,
        reject: eligibility,
        checkedAt: expect.any(String),
      });
      const decide = (user: TestUser, id: string, action: 'approve' | 'reject') =>
        bearer(user).post(`/v1/admin/finance/adjustments/${id}/${action}`, { note: 'Checked' });
      const before = { money: await moneySnapshot(), audit: await ctx.prisma.auditLog.count() };

      // Own request (maker-checker).
      expect(await reviewOf(accountant)).toEqual({
        [small]: both(refused('OWN_REQUEST')),
        [large]: both(refused('OWN_REQUEST')),
        [linked]: both(refused('OWN_REQUEST')),
      });
      // Another accountant: allowed below the approval threshold, not above it.
      expect(await reviewOf(accountant2)).toEqual({
        [small]: both(allowed),
        [large]: both(refused('OVER_LIMIT')),
        [linked]: both(allowed),
      });
      // The admin who acted as the merchant: involved in the linked shipment, and not
      // independent for UNLINKED ones (whatever the amount).
      expect(await reviewOf(admin)).toEqual({
        [small]: both(refused('CONFLICT_OF_INTEREST')),
        [large]: both(refused('CONFLICT_OF_INTEREST')),
        [linked]: both(refused('CONFLICT_OF_INTEREST')),
      });
      // An independent super admin may decide all of them, also above the threshold.
      expect(await reviewOf(otherAdmin)).toEqual({
        [small]: both(allowed),
        [large]: both(allowed),
        [linked]: both(allowed),
      });
      // Viewers who cannot decide get no eligibility at all.
      expect(Object.values(await reviewOf(owner))).toEqual([null, null, null]);
      // Reading eligibility wrote nothing.
      expect({ money: await moneySnapshot(), audit: await ctx.prisma.auditLog.count() }).toEqual(
        before,
      );

      // The decision does not rely on the list: every refusal is enforced again.
      for (const action of ['approve', 'reject'] as const) {
        expect((await decide(accountant, small, action)).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
        expect((await decide(accountant2, large, action)).body.code).toBe(
          'APPROVAL_LIMIT_EXCEEDED',
        );
        expect((await decide(admin, small, action)).body.code).toBe('IMPERSONATION_CONFLICT');
      }
      // Stale information: accountant2 was told "allowed" on the small one, then the threshold
      // dropped. The decision is refused, and the list says so on the next read.
      await ctx.prisma.financeSetting.update({
        where: { key: 'APPROVAL_THRESHOLD' },
        data: { value: '1.00' },
      });
      expect((await decide(accountant2, small, 'approve')).body.code).toBe(
        'APPROVAL_LIMIT_EXCEEDED',
      );
      expect((await reviewOf(accountant2))[small]).toEqual(both(refused('OVER_LIMIT')));
      await ctx.prisma.financeSetting.update({
        where: { key: 'APPROVAL_THRESHOLD' },
        data: { value: '200.00' },
      });

      // Decided adjustments carry no eligibility.
      await decide(otherAdmin, linked, 'approve').expect(200);
      expect((await reviewOf(otherAdmin))[linked]).toBeNull();

      // When the checks cannot run, every pending item is refused (UNKNOWN), never allowed.
      const spy = vi
        .spyOn(ctx.app.get(ApprovalService), 'approvalRefusal')
        .mockRejectedValueOnce(new Error('unavailable'));
      const failed = await reviewOf(otherAdmin);
      spy.mockRestore();
      expect(failed[small]).toEqual(both(refused('UNKNOWN')));
      expect(failed[large]).toEqual(both(refused('UNKNOWN')));
      // ...and the authorized independent reviewer can still decide.
      await decide(otherAdmin, small, 'approve').expect(200);
    });
  });

  it('opens exactly the approved write routes with writes enabled; every other write is refused', async () => {
    const before = await moneySnapshot();
    const open = new Set([
      'POST /v1/auth/logout',
      'POST /v1/impersonation/end',
      'POST /v1/merchant/shipments',
      'POST /v1/merchant/pricing/quote',
      'POST /v1/merchant/shipments/:id/transitions',
      'POST /v1/driver/shipments/:id/transitions',
    ]);
    const writes = Object.entries(IMPERSONATION_ROUTE_POLICY as Record<string, { access: string }>)
      .filter(([key, policy]) => !key.startsWith('GET ') && policy.access !== 'PUBLIC')
      .map(([key]) => key);
    const { cookie } = await impersonate(merchant);
    for (const key of writes.filter((k) => !open.has(k))) {
      const [method, path] = key.split(' ') as [string, string];
      const agent = request(server());
      const verb = method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
      const res = await agent[verb](path.replace(/:[A-Za-z]+/g, randomUUID()))
        .set('cookie', cookie)
        .set(IMPERSONATION_HEADER, '1')
        .set('origin', MERCHANT_ORIGIN)
        .send({});
      expect(res.status, key).toBe(403);
      expect(res.body.code, key).toBe('IMPERSONATION_FORBIDDEN_ACTION');
    }
    // The open set is exactly the SAFEGUARDED routes plus the two that end the impersonation.
    const safeguarded = Object.entries(
      IMPERSONATION_ROUTE_POLICY as Record<string, { access: string }>,
    )
      .filter(([, policy]) => policy.access === 'SAFEGUARDED')
      .map(([key]) => key);
    expect([...open].filter((k) => !k.includes('logout') && !k.includes('/end')).sort()).toEqual(
      safeguarded.sort(),
    );
    expect(await moneySnapshot()).toEqual(before);
  });

  it('allows the driver return trip with charges confirmed, but never the final RETURNED', async () => {
    const id = await outForDelivery();
    await bearer(driver)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERY_FAILED',
        reason: 'Nobody home',
      })
      .expect(200);
    await bearer(merchant)
      .post(`/v1/merchant/shipments/${id}/transitions`, {
        toStatus: 'RETURN_REQUESTED',
        reason: 'Return',
      })
      .expect(200);
    await bearer(ops)
      .post(`/v1/admin/shipments/${id}/return/approve`, { driverId: driver.id })
      .expect(200);
    const before = await moneySnapshot();
    const { as } = await impersonate(driver);
    for (const toStatus of ['RETURN_IN_TRANSIT', 'RETURNED_TO_HUB']) {
      if (toStatus === 'RETURNED_TO_HUB') {
        // From RETURN_IN_TRANSIT the driver's own RETURNED would post the return fee: refused.
        const returned = await as.post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus: 'RETURNED',
          reason: 'Delivered back',
        });
        expect(returned.status).toBe(403);
        expect(returned.body.code).toBe('IMPERSONATION_FORBIDDEN_ACTION');
        await as.get(`/v1/driver/shipments/${id}/consequences?toStatus=RETURNED`).expect(403);
      }
      const preview = await previewTransition(as, 'driver', id, toStatus);
      expect(preview.lines).toEqual([
        expect.objectContaining({ kind: 'RETURN_FEE', amount: '10.00', certainty: 'FIXED' }),
      ]);
      await as
        .post(`/v1/driver/shipments/${id}/transitions`, {
          toStatus,
          reason: 'Driver phone broken',
          confirmationToken: preview.confirmationToken,
        })
        .expect(200);
    }
    expect((await ctx.prisma.shipment.findUniqueOrThrow({ where: { id } })).status).toBe(
      'RETURNED_TO_HUB',
    );
    expect(await moneySnapshot()).toEqual(before);
  });

  it('leaves ordinary merchant and driver behaviour unchanged', async () => {
    const created = await bearer(merchant)
      .post('/v1/merchant/shipments', shipmentInput())
      .expect(201);
    expect(created.body.createdBy?.id ?? merchant.id).toBe(merchant.id);
    const row = await ctx.prisma.shipment.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row).toMatchObject({
      createdById: merchant.id,
      creatorRole: 'MERCHANT',
      createdImpersonationId: null,
    });
    // Previews are impersonation-only.
    await bearer(merchant)
      .get(`/v1/merchant/shipment-consequences?destinationZoneId=${zones.ramallah}&codAmount=10`)
      .expect(403);
    await bearer(merchant)
      .post(`/v1/merchant/shipments/${created.body.id}/transitions`, {
        toStatus: 'CANCELLED',
        reason: 'Own cancel',
      })
      .expect(200);
  });
});
