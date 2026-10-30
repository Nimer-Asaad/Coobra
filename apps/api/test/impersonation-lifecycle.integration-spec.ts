import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server as App } from 'node:http';
import { IMPERSONATION_HEADER, IMPERSONATION_ROUTE_POLICY } from '@coobra/shared';
import { CLOCK, type Clock } from '../src/common/clock.js';
import { ImpersonationSweeper } from '../src/impersonation/impersonation-sweeper.service.js';
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
 * Phase 4C.3: the impersonation lifecycle end to end (ADR 0003 §5, §8, §9, §13). Every
 * impersonated write stays forbidden in this phase; only reads, logout and End are allowed.
 */

const MERCHANT_ORIGIN = 'http://localhost:8082';
const DRIVER_ORIGIN = 'http://localhost:8081';
const MINUTE = 60_000;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('Impersonation lifecycle (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let clock: Clock;
  let sweeper: ImpersonationSweeper;
  let admin: TestUser;
  let otherAdmin: TestUser;
  let accountant: TestUser;
  let merchant: TestUser;
  let otherMerchant: TestUser;
  let driver: TestUser;
  let offsetMs = 0;
  const server = () => ctx.app.getHttpServer() as App;
  const bearer = (user: { token: string }) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
  });
  /** An app tab acting under an impersonation (cookie + header + exact origin). */
  const tab = (cookie: string, origin = MERCHANT_ORIGIN) => ({
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

  async function reauth(user = admin) {
    await bearer(user).post('/v1/auth/reauthenticate', { password: TEST_PASSWORD }).expect(204);
  }

  async function start(target: TestUser, actor = admin, { reauthenticate = true } = {}) {
    if (reauthenticate) await reauth(actor);
    const keys = pkce();
    const res = await bearer(actor).post('/v1/admin/impersonations', {
      targetUserId: target.id,
      reason: 'Customer asked for help with a shipment',
      codeChallenge: keys.challenge,
    });
    return { res, ...keys };
  }

  function exchange(code: string, verifier: string, origin = MERCHANT_ORIGIN) {
    return request(server())
      .post('/v1/auth/impersonation/exchange')
      .set(IMPERSONATION_HEADER, '1')
      .set('origin', origin)
      .send({ code, codeVerifier: verifier });
  }

  /** Start and exchange: returns the impersonation id and the tab's cookie. */
  async function impersonate(target = merchant, actor = admin) {
    const started = await start(target, actor);
    expect(started.res.status).toBe(201);
    const origin = target.role === 'DRIVER' ? DRIVER_ORIGIN : MERCHANT_ORIGIN;
    const res = await exchange(started.res.body.code, started.verifier, origin).expect(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const cookie = setCookie.find((c) => c.startsWith('coobra_imp_session='));
    expect(cookie).toBeDefined();
    return {
      id: started.res.body.impersonation.id as string,
      cookie: cookie!.split(';')[0]!,
      setCookie: cookie!,
      origin,
    };
  }

  const impersonationRow = (id: string) =>
    ctx.prisma.impersonationSession.findUniqueOrThrow({ where: { id } });

  async function moneySnapshot() {
    const tables = [
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
      'shipments',
      'pricing_quotes',
      'pickup_zone_requests',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const rows = await ctx.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table}`,
      );
      counts[table] = Number(rows[0]!.n);
    }
    return counts;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    clock = ctx.app.get<Clock>(CLOCK);
    sweeper = ctx.app.get(ImpersonationSweeper);
    vi.spyOn(clock, 'now').mockImplementation(() => new Date(Date.now() + offsetMs));
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(ctx.prisma);
    ctx.mail.sent.length = 0;
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com', {
      fullName: 'Admin One',
    });
    otherAdmin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin2@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'accountant@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'merchant@example.com');
    otherMerchant = await createSignedInUser(ctx, 'MERCHANT', 'merchant2@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'driver@example.com');
    await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await resetDatabase(ctx.prisma);
    await ctx?.app.close();
  });

  describe('start and exchange', () => {
    it('starts after a password step-up, hands off by code and acts as the merchant for reads', async () => {
      const started = await start(merchant);
      expect(started.res.status).toBe(201);
      expect(started.res.headers['cache-control']).toBe('no-store');
      expect(started.res.body).toMatchObject({
        appOrigin: MERCHANT_ORIGIN,
        impersonation: { actor: { id: admin.id }, target: { id: merchant.id, role: 'MERCHANT' } },
      });
      const res = await exchange(started.res.body.code, started.verifier).expect(200);
      const cookie = ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('coobra_imp_session='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/i);
      const tabCookie = cookie.split(';')[0]!;

      const me = await tab(tabCookie).get('/v1/auth/me').expect(200);
      expect(me.body.user.id).toBe(merchant.id);
      expect(me.body.impersonation).toMatchObject({
        actor: { id: admin.id },
        target: { id: merchant.id },
      });
      await tab(tabCookie).get('/v1/merchant/shipments').expect(200);

      const startedAudit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'IMPERSONATION_STARTED' },
      });
      expect(startedAudit).toMatchObject({
        actorUserId: admin.id,
        targetUserId: merchant.id,
        effectiveUserId: null,
      });
      // The temporary session ends with the impersonation (absolute, non-renewable).
      const imp = await impersonationRow(started.res.body.impersonation.id);
      const session = await ctx.prisma.session.findUniqueOrThrow({
        where: { impersonationId: imp.id },
      });
      expect(session.expiresAt.getTime()).toBe(imp.expiresAt.getTime());
      expect(imp.expiresAt.getTime() - imp.startedAt.getTime()).toBe(30 * MINUTE);
    });

    it('requires a recent password step-up, used up by one start', async () => {
      const without = await start(merchant, admin, { reauthenticate: false });
      expect(without.res.status).toBe(403);
      expect(without.res.body.code).toBe('REAUTH_REQUIRED');

      await bearer(admin)
        .post('/v1/auth/reauthenticate', { password: 'wrong-password-1' })
        .expect(401);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'AUTH_REAUTHENTICATION_FAILED' } }),
      ).toBe(1);

      await reauth();
      offsetMs = 6 * MINUTE; // the step-up is valid for 5 minutes
      expect((await start(merchant, admin, { reauthenticate: false })).res.status).toBe(403);

      offsetMs = 0;
      const first = await impersonate();
      await bearer(admin).post(`/v1/admin/impersonations/${first.id}/end`).expect(200);
      // The previous step-up was used by that start.
      expect((await start(driver, admin, { reauthenticate: false })).res.status).toBe(403);
    });

    it('refuses yourself, staff, other super admins, disabled and unknown accounts', async () => {
      const refusals = [admin, otherAdmin, accountant];
      for (const target of refusals) {
        const { res } = await start(target);
        expect(res.status, target.email).toBe(403);
        expect(res.body.code).toBe('IMPERSONATION_NOT_ALLOWED');
      }
      await ctx.prisma.user.update({
        where: { id: otherMerchant.id },
        data: { status: 'DISABLED' },
      });
      expect((await start(otherMerchant)).res.body.code).toBe('IMPERSONATION_NOT_ALLOWED');
      await reauth();
      const unknown = await bearer(admin).post('/v1/admin/impersonations', {
        targetUserId: randomUUID(),
        reason: 'Unknown account',
        codeChallenge: pkce().challenge,
      });
      expect(unknown.status).toBe(404);
    });

    it('allows one active impersonation per admin and per account, even when racing', async () => {
      await impersonate(merchant, admin);
      const sameTarget = await start(merchant, otherAdmin);
      expect(sameTarget.res.status).toBe(409);
      expect(sameTarget.res.body.code).toBe('IMPERSONATION_ACTIVE');
      expect((await start(driver, admin)).res.status).toBe(409);

      // Two free admins race for the same free account: exactly one wins.
      const thirdAdmin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin3@example.com');
      await reauth(otherAdmin);
      await reauth(thirdAdmin);
      const race = await Promise.all(
        [otherAdmin, thirdAdmin].map((actor) =>
          bearer(actor).post('/v1/admin/impersonations', {
            targetUserId: otherMerchant.id,
            reason: 'Racing for the same account',
            codeChallenge: pkce().challenge,
          }),
        ),
      );
      expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await ctx.prisma.impersonationSession.count({
          where: { targetUserId: otherMerchant.id, endedAt: null },
        }),
      ).toBe(1);
    });

    it('accepts a code once, from the exact app origin, with the matching verifier only', async () => {
      const a = await start(merchant);
      await exchange(a.res.body.code, a.verifier, DRIVER_ORIGIN).expect(403);
      await request(server())
        .post('/v1/auth/impersonation/exchange')
        .set('origin', MERCHANT_ORIGIN)
        .send({ code: a.res.body.code, codeVerifier: a.verifier })
        .expect(403);
      // A wrong verifier burns the code: the right one no longer works.
      await exchange(a.res.body.code, pkce().verifier).expect(401);
      await exchange(a.res.body.code, a.verifier).expect(401);
      await bearer(admin)
        .post(`/v1/admin/impersonations/${a.res.body.impersonation.id}/end`)
        .expect(200);

      const b = await start(merchant);
      await exchange(b.res.body.code, b.verifier).expect(200);
      await exchange(b.res.body.code, b.verifier).expect(401); // replay
      await bearer(admin)
        .post(`/v1/admin/impersonations/${b.res.body.impersonation.id}/end`)
        .expect(200);

      const c = await start(merchant);
      await bearer(admin)
        .post(`/v1/admin/impersonations/${c.res.body.impersonation.id}/end`)
        .expect(200);
      await exchange(c.res.body.code, c.verifier).expect(401); // ended before the hand-off
    });
  });

  describe('every impersonated request', () => {
    it('denies by default: writes, money, settings and staff routes are forbidden', async () => {
      const { cookie } = await impersonate();
      const before = await moneySnapshot();
      const forbidden: [string, string, object?][] = [
        ['post', '/v1/merchant/shipments', { recipientName: 'X' }],
        ['post', '/v1/merchant/pricing/quote', { destinationZoneId: randomUUID() }],
        ['post', '/v1/merchant/finance/payouts', { amount: '10' }],
        ['post', `/v1/merchant/finance/shortfalls/${randomUUID()}/accept`, {}],
        ['post', '/v1/auth/resend-verification', {}],
        ['get', '/v1/admin/users'],
        ['get', '/v1/admin/impersonations'],
        ['post', '/v1/admin/impersonations', {}],
        ['post', '/v1/auth/reauthenticate', { password: TEST_PASSWORD }],
      ];
      for (const [method, path, body] of forbidden) {
        const res =
          method === 'get' ? await tab(cookie).get(path) : await tab(cookie).post(path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code, `${method} ${path}`).toBe('IMPERSONATION_FORBIDDEN_ACTION');
      }
      const prefs = await request(server())
        .patch('/v1/me/preferences')
        .set('cookie', cookie)
        .set(IMPERSONATION_HEADER, '1')
        .set('origin', MERCHANT_ORIGIN)
        .send({ language: 'ar' });
      expect(prefs.status).toBe(403);
      expect(await moneySnapshot()).toEqual(before);
    });

    it('needs the header, the exact origin and the cookie, and never works as an ordinary session', async () => {
      const { cookie } = await impersonate();
      await tab(cookie, DRIVER_ORIGIN).get('/v1/merchant/shipments').expect(403);
      await request(server())
        .get('/v1/merchant/shipments')
        .set('cookie', cookie)
        .set(IMPERSONATION_HEADER, '1')
        .expect(403); // no Origin
      // Without the header the impersonation cookie is ignored.
      await request(server()).get('/v1/merchant/shipments').set('cookie', cookie).expect(401);
      const token = cookie.split('=')[1]!;
      // The temporary token as a Bearer (ordinary) session, with or without the header.
      await request(server())
        .get('/v1/auth/me')
        .set('authorization', `Bearer ${token}`)
        .expect(401);
      await request(server())
        .get('/v1/auth/me')
        .set('authorization', `Bearer ${token}`)
        .set(IMPERSONATION_HEADER, '1')
        .set('origin', MERCHANT_ORIGIN)
        .expect(401);
    });

    it('stops at the 30-minute limit, and the sweeper records the expiry', async () => {
      const { id, cookie } = await impersonate();
      offsetMs = 30 * MINUTE + 1000;
      await tab(cookie).get('/v1/merchant/shipments').expect(401);
      expect((await sweeper.runOnce()).ended).toBe(1);
      expect((await impersonationRow(id)).endedReason).toBe('EXPIRED');
      // A second sweep finds nothing; the slots are free again.
      expect(await sweeper.endStale()).toBe(0);
    });
  });

  describe('ending', () => {
    it('ends from the banner, once, and revokes the tab session', async () => {
      const { id, cookie } = await impersonate();
      const res = await tab(cookie).post('/v1/impersonation/end').expect(200);
      expect(res.body.endedReason).toBe('MANUAL');
      await tab(cookie).get('/v1/merchant/shipments').expect(401);
      const again = await bearer(admin).post(`/v1/admin/impersonations/${id}/end`).expect(200);
      expect(again.body.endedAt).toBe(res.body.endedAt);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'IMPERSONATION_ENDED' } })).toBe(1);
      expect(await ctx.prisma.notificationOutbox.count()).toBe(1);
    });

    it('is idempotent when several enders race', async () => {
      const { id, cookie } = await impersonate();
      await Promise.all([
        bearer(admin).post(`/v1/admin/impersonations/${id}/end`),
        bearer(otherAdmin).post(`/v1/admin/impersonations/${id}/end`),
        tab(cookie).post('/v1/impersonation/end'),
        sweeper.endStale(),
      ]);
      expect((await impersonationRow(id)).endedAt).not.toBeNull();
      expect(await ctx.prisma.auditLog.count({ where: { action: 'IMPERSONATION_ENDED' } })).toBe(1);
      expect(await ctx.prisma.notificationOutbox.count()).toBe(1);
    });

    it('signing out of the impersonation ends it without touching the account’s own sessions', async () => {
      const { id, cookie } = await impersonate();
      await tab(cookie).post('/v1/auth/logout').expect(204);
      expect((await impersonationRow(id)).endedReason).toBe('MANUAL');
      await bearer(merchant).get('/v1/auth/me').expect(200);
      await bearer(admin).get('/v1/auth/me').expect(200);
    });

    it('ends when the admin signs out or their admin session ends', async () => {
      const first = await impersonate();
      await bearer(admin).post('/v1/auth/logout').expect(204);
      expect((await impersonationRow(first.id)).endedReason).toBe('ACTOR_LOGOUT');
      await tab(first.cookie).get('/v1/merchant/shipments').expect(401);

      const second = await impersonate(merchant, otherAdmin);
      // The admin session expires (or is revoked elsewhere): every request and the sweeper stop it.
      await ctx.prisma.session.updateMany({
        where: { userId: otherAdmin.id, impersonationId: null },
        data: { revokedAt: new Date() },
      });
      await tab(second.cookie).get('/v1/merchant/shipments').expect(401);
      await sweeper.endStale();
      expect((await impersonationRow(second.id)).endedReason).toBe('ACTOR_SESSION_ENDED');
    });

    it('ends when the target or the admin is deactivated', async () => {
      const version = async (id: string) =>
        (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
      const target = await impersonate(merchant, admin);
      await bearer(otherAdmin)
        .post(`/v1/admin/users/${merchant.id}/deactivate`, {
          reason: 'Closed account',
          expectedUpdatedAt: await version(merchant.id),
        })
        .expect(200);
      expect((await impersonationRow(target.id)).endedReason).toBe('TARGET_REVOKED');

      const actor = await impersonate(driver, admin);
      await bearer(otherAdmin)
        .post(`/v1/admin/users/${admin.id}/deactivate`, {
          reason: 'Left the company',
          expectedUpdatedAt: await version(admin.id),
        })
        .expect(200);
      expect((await impersonationRow(actor.id)).endedReason).toBe('ACTOR_REVOKED');
      await tab(actor.cookie, DRIVER_ORIGIN).get('/v1/driver/shipments').expect(401);
    });
  });

  describe('summary email (durable outbox)', () => {
    it('sends the account holder one safe summary, with a stable Message-ID', async () => {
      const { id, cookie } = await impersonate();
      await tab(cookie).post('/v1/impersonation/end').expect(200);
      expect(await sweeper.runOnce()).toMatchObject({ sent: 1 });
      const outbox = await ctx.prisma.notificationOutbox.findFirstOrThrow({
        where: { impersonationId: id },
      });
      expect(outbox).toMatchObject({ status: 'SENT', attempts: 1, leaseToken: null });
      const mail = ctx.mail.sent.filter((m) => m.to === merchant.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.messageId).toBe(`<notification-${outbox.id}@coobra.local>`);
      expect(mail[0]!.text).toContain('Admin One');
      // Never the support reason, a link or a code.
      expect(mail[0]!.text).not.toContain('Customer asked');
      expect(mail[0]!.text).not.toMatch(/https?:\/\//);
      expect(await sweeper.runOnce()).toMatchObject({ sent: 0 });
    });

    it('never blocks ending; retries with backoff and stops after 5 attempts', async () => {
      const send = vi.spyOn(ctx.mail, 'send').mockRejectedValue(new Error('SMTP down'));
      try {
        const { id, cookie } = await impersonate();
        await tab(cookie).post('/v1/impersonation/end').expect(200);
        expect((await impersonationRow(id)).endedAt).not.toBeNull();
        for (let attempt = 1; attempt <= 5; attempt++) {
          await sweeper.runOnce();
          offsetMs += 10 * MINUTE; // past every backoff and lease
        }
        const outbox = await ctx.prisma.notificationOutbox.findFirstOrThrow({
          where: { impersonationId: id },
        });
        expect(outbox).toMatchObject({
          status: 'FAILED',
          attempts: 5,
          leaseToken: null,
          lastError: 'Error',
        });
        expect(await sweeper.runOnce()).toMatchObject({ sent: 0, retried: 0, failed: 0 });
      } finally {
        send.mockRestore();
      }
    });

    it('does not take a row another instance holds a live lease on (fencing)', async () => {
      const { cookie } = await impersonate();
      await tab(cookie).post('/v1/impersonation/end').expect(200);
      const lease = randomUUID();
      await ctx.prisma.notificationOutbox.updateMany({
        data: { leaseToken: lease, leaseExpiresAt: new Date(Date.now() + 5 * MINUTE), attempts: 1 },
      });
      expect(await sweeper.runOnce()).toMatchObject({ sent: 0 });
      expect(ctx.mail.sent.filter((m) => m.to === merchant.email)).toHaveLength(0);
      // Once that lease lapses, this instance takes over with its own token.
      offsetMs = 6 * MINUTE;
      expect(await sweeper.runOnce()).toMatchObject({ sent: 1 });
      const outbox = await ctx.prisma.notificationOutbox.findFirstOrThrow();
      expect(outbox).toMatchObject({ status: 'SENT', attempts: 2 });
    });
  });

  it('leaves every ledger and money table untouched across a whole lifecycle', async () => {
    const before = await moneySnapshot();
    const journal = await ctx.prisma.journalEntry.count();
    const { cookie } = await impersonate();
    await tab(cookie).get('/v1/merchant/finance').expect(200);
    await tab(cookie).post('/v1/merchant/finance/payouts', { amount: '10' }).expect(403);
    await tab(cookie).post('/v1/impersonation/end').expect(200);
    await sweeper.runOnce();
    expect(await moneySnapshot()).toEqual(before);
    expect(await ctx.prisma.journalEntry.count()).toBe(journal);
  });

  describe('security gate', () => {
    it('fails closed when the deployment does not qualify (R4)', async () => {
      const live = await impersonate();
      ctx.config.impersonation.enabled = false;
      try {
        const step = await bearer(admin).post('/v1/auth/reauthenticate', {
          password: TEST_PASSWORD,
        });
        expect(step.status).toBe(403);
        expect(step.body.code).toBe('IMPERSONATION_NOT_ALLOWED');
        const started = await bearer(otherAdmin).post('/v1/admin/impersonations', {
          targetUserId: otherMerchant.id,
          reason: 'Should be refused',
          codeChallenge: pkce().challenge,
        });
        expect(started.status).toBe(403);
        const keys = pkce();
        await exchange(randomBytes(32).toString('base64url'), keys.verifier).expect(403);
        // An impersonation already running stops working at once.
        await tab(live.cookie).get('/v1/merchant/shipments').expect(401);
      } finally {
        ctx.config.impersonation.enabled = true;
      }
    });

    it('limits password step-up across API instances through the database', async () => {
      const second = await createTestApp();
      try {
        const via = (app: TestContext) => (password: string) =>
          request(app.app.getHttpServer() as App)
            .post('/v1/auth/reauthenticate')
            .set('authorization', `Bearer ${admin.token}`)
            .send({ password });
        // A parallel burst spread over two instances: never more than 5 failures are evaluated.
        const burst = await Promise.all(
          Array.from({ length: 8 }, (_, i) => via(i % 2 ? second : ctx)('wrong-password-1')),
        );
        expect(burst.filter((r) => r.status === 401)).toHaveLength(5);
        expect(burst.filter((r) => r.status === 429)).toHaveLength(3);
        expect(
          await ctx.prisma.auditLog.count({ where: { action: 'AUTH_REAUTHENTICATION_FAILED' } }),
        ).toBe(5);
        // Locked on both instances, even with the right password.
        await via(ctx)(TEST_PASSWORD).expect(429);
        await via(second)(TEST_PASSWORD).expect(429);
        offsetMs = 16 * MINUTE;
        await via(second)(TEST_PASSWORD).expect(204);
      } finally {
        await second.app.close();
      }
    });

    it('refuses an impersonation at its exact expiry instant and after any revocation', async () => {
      const first = await impersonate();
      const row = await impersonationRow(first.id);
      offsetMs = row.expiresAt.getTime() - Date.now() - 2000;
      await tab(first.cookie).get('/v1/merchant/shipments').expect(200);
      offsetMs = row.expiresAt.getTime() - Date.now();
      await tab(first.cookie).get('/v1/merchant/shipments').expect(401);
      offsetMs = 0;
      await sweeper.endStale();

      const revocations: [string, (id: string) => Promise<unknown>][] = [
        [
          'temporary session revoked',
          (id) =>
            ctx.prisma.session.updateMany({
              where: { impersonationId: id },
              data: { revokedAt: new Date() },
            }),
        ],
        [
          'target disabled',
          () =>
            ctx.prisma.user.update({ where: { id: merchant.id }, data: { status: 'DISABLED' } }),
        ],
        [
          'actor no longer SUPER_ADMIN',
          () => ctx.prisma.user.update({ where: { id: admin.id }, data: { role: 'OPERATIONS' } }),
        ],
        [
          'admin session expired',
          () =>
            ctx.prisma.session.updateMany({
              where: { userId: admin.id, impersonationId: null },
              data: { expiresAt: new Date(Date.now() - 1000) },
            }),
        ],
      ];
      for (const [name, revoke] of revocations) {
        await resetDatabase(ctx.prisma);
        admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
        otherAdmin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin2@example.com');
        merchant = await createSignedInUser(ctx, 'MERCHANT', 'merchant@example.com');
        const live = await impersonate();
        await tab(live.cookie).get('/v1/merchant/shipments').expect(200);
        await revoke(live.id);
        const res = await tab(live.cookie).get('/v1/merchant/shipments');
        expect(res.status, name).toBe(401);
      }
    });

    it('never serves a request that starts after the end committed, even under load', async () => {
      const { id, cookie } = await impersonate();
      // Started before the end (supertest only sends once awaited, hence .then).
      const during = Array.from({ length: 10 }, () =>
        tab(cookie)
          .get('/v1/merchant/shipments')
          .then((r) => r.status),
      );
      await bearer(admin).post(`/v1/admin/impersonations/${id}/end`).expect(200);
      await Promise.all(during); // in-flight reads may finish either way; none can write
      const after = await Promise.all(
        Array.from({ length: 10 }, () => tab(cookie).get('/v1/merchant/shipments')),
      );
      expect(after.every((r) => r.status === 401)).toBe(true);
    });

    it('refuses every write route of the API during an impersonation, except ending it', async () => {
      const { cookie } = await impersonate();
      const before = await moneySnapshot();
      const ending = new Set(['POST /v1/auth/logout', 'POST /v1/impersonation/end']);
      const routes = Object.entries(
        IMPERSONATION_ROUTE_POLICY as Record<string, { access: string }>,
      )
        .filter(([key, policy]) => !key.startsWith('GET ') && policy.access !== 'PUBLIC')
        .filter(([key]) => !ending.has(key))
        .map(([key]) => key);
      // Every non-GET route the API registers (63 today), from the classification registry.
      expect(routes.length).toBeGreaterThanOrEqual(63);
      for (const key of routes) {
        const [method, path] = key.split(' ') as [string, string];
        const url = path.replace(/:[A-Za-z]+/g, randomUUID());
        const agent = request(server());
        const verb = method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
        const res = await agent[verb](url)
          .set('cookie', cookie)
          .set(IMPERSONATION_HEADER, '1')
          .set('origin', MERCHANT_ORIGIN)
          .send({});
        expect(res.status, key).toBe(403);
        expect(res.body.code, key).toBe('IMPERSONATION_FORBIDDEN_ACTION');
      }
      expect(await moneySnapshot()).toEqual(before);
    });

    it('leaves every ordinary user’s permissions unchanged while an impersonation runs', async () => {
      const zones = await setupBasicPricing(ctx.prisma, [otherMerchant.id]);
      await impersonate(merchant, admin);
      // The impersonated merchant keeps working in their own session.
      await bearer(merchant)
        .post('/v1/merchant/shipments', {
          recipientName: 'Ahmad Khalil',
          recipientPhone: '0599123456',
          city: 'Al-Bireh',
          addressLine: 'Main street',
          codAmount: '50',
          destinationZoneId: zones.ramallah,
        })
        .expect(201);
      await bearer(admin).get('/v1/admin/users').expect(200);
      await bearer(accountant).get('/v1/admin/finance/overview').expect(200);
      await bearer(merchant).get('/v1/admin/users').expect(403);
      await bearer(driver).get('/v1/driver/shipments').expect(200);
    });

    it('never writes a password, code, verifier, token or cookie to the logs', async () => {
      const written: string[] = [];
      const capture = (stream: NodeJS.WriteStream) =>
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
          written.push(String(chunk));
          return true;
        }) as never);
      const out = capture(process.stdout);
      const err = capture(process.stderr);
      let secrets: string[] = [];
      try {
        await bearer(admin).post('/v1/auth/reauthenticate', { password: 'wrong-password-9' });
        const started = await start(merchant);
        await exchange(started.res.body.code, pkce().verifier); // wrong verifier
        const second = await start(otherMerchant, otherAdmin);
        const ok = await exchange(second.res.body.code, second.verifier);
        const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
        await tab(cookie).get('/v1/auth/me');
        await tab(cookie, DRIVER_ORIGIN).get('/v1/auth/me');
        await tab(cookie).post('/v1/impersonation/end');
        await sweeper.runOnce();
        secrets = [
          'wrong-password-9',
          TEST_PASSWORD,
          started.res.body.code,
          started.verifier,
          second.res.body.code,
          second.verifier,
          cookie.split('=')[1]!,
          admin.token,
        ];
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      const logs = written.join('');
      for (const secret of secrets) expect(logs.includes(secret)).toBe(false);
    });
  });
});
