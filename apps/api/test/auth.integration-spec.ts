import request from 'supertest';
import type { Server as App } from 'node:http';
import {
  ALLOWED_ORIGIN,
  createSuperAdmin,
  createTestApp,
  resetDatabase,
  type TestContext,
} from './helpers.js';

const merchant = {
  fullName: 'Lina Merchant',
  businessName: 'Lina Store',
  email: 'lina@example.com',
  phone: '+970599111222',
  password: 'merchant-pass-123',
  language: 'ar',
};

describe('Authentication (PostgreSQL integration)', () => {
  let ctx: TestContext;
  const server = () => ctx.app.getHttpServer() as App;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.mail.sent.length = 0;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  function register(overrides: Record<string, unknown> = {}) {
    return request(server())
      .post('/v1/auth/register')
      .send({ ...merchant, ...overrides });
  }

  it('reports liveness and database readiness', async () => {
    await request(server())
      .get('/health')
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('ok'));
    await request(server()).get('/health/ready').expect(200, { status: 'ok', database: 'up' });
  });

  it('registers merchants only, hashing the password with Argon2id', async () => {
    const res = await register({ role: 'SUPER_ADMIN', email: 'LINA@Example.com ' }).expect(201);
    expect(res.body.user).toMatchObject({
      email: 'lina@example.com',
      role: 'MERCHANT',
      emailVerified: false,
      language: 'ar',
      merchant: { businessName: 'Lina Store' },
    });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'lina@example.com' },
    });
    expect(stored.role).toBe('MERCHANT');
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: stored.id } });
    expect(session.tokenHash).not.toBe(res.body.token);

    const verification = await ctx.mail.tokenFor('lina@example.com');
    expect(verification.length).toBeGreaterThan(20);
    expect(ctx.mail.sent[0]?.subject).toBe('تأكيد بريدك الإلكتروني في كوبرا');
    expect(ctx.mail.sent[0]?.text).toContain('http://localhost:8082/verify-email?token=');
  });

  // QA BUG-001: Arabic-Indic digits in the registration phone are normalised, not rejected.
  it('accepts and normalises Arabic-Indic digits in the merchant phone', async () => {
    await register({ email: 'digits@example.com', phone: '٠٥٩٩١١١٢٢٢' }).expect(201);
    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'digits@example.com' },
    });
    expect(stored.phone).toBe('0599111222');
  });

  it('rejects duplicate emails and translatable validation errors', async () => {
    await register().expect(201);
    const dup = await register().expect(409);
    expect(dup.body.code).toBe('AUTH_EMAIL_ALREADY_REGISTERED');

    const invalid = await register({ email: 'nope', password: 'short' }).expect(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: { email: 'validation.email.invalid', password: 'validation.password.tooShort' },
    });
  });

  it('verifies email with a single-use token', async () => {
    const { body } = await register().expect(201);
    const auth = { Authorization: `Bearer ${body.token}` };

    await request(server()).get('/v1/auth/me').set(auth).expect(200);
    const token = await ctx.mail.tokenFor(merchant.email);

    await request(server()).post('/v1/auth/verify-email').send({ token }).expect(200);
    const reuse = await request(server()).post('/v1/auth/verify-email').send({ token }).expect(400);
    expect(reuse.body.code).toBe('AUTH_TOKEN_INVALID');

    const me = await request(server()).get('/v1/auth/me').set(auth).expect(200);
    expect(me.body.user.emailVerified).toBe(true);

    const resend = await request(server())
      .post('/v1/auth/resend-verification')
      .set(auth)
      .expect(409);
    expect(resend.body.code).toBe('AUTH_EMAIL_ALREADY_VERIFIED');
  });

  it('logs in, enforces the client app per role, and logs out', async () => {
    await register().expect(201);

    const wrong = await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: 'wrong-pass-123', clientApp: 'MERCHANT_APP' })
      .expect(401);
    expect(wrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    const unknown = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'whatever-123', clientApp: 'MERCHANT_APP' })
      .expect(401);
    expect(unknown.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    const admin = await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: merchant.password, clientApp: 'ADMIN_WEB' })
      .expect(403);
    expect(admin.body.code).toBe('AUTH_ROLE_NOT_ALLOWED_FOR_APP');

    const ok = await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: merchant.password, clientApp: 'MERCHANT_APP' })
      .expect(200);
    const auth = { Authorization: `Bearer ${ok.body.token}` };
    await request(server()).get('/v1/auth/me').set(auth).expect(200);
    await request(server()).post('/v1/auth/logout').set(auth).expect(204);
    await request(server()).get('/v1/auth/me').set(auth).expect(401);

    const actions = (await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (log) => log.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'AUTH_REGISTERED',
        'AUTH_LOGIN_FAILED',
        'AUTH_LOGIN_SUCCEEDED',
        'AUTH_LOGOUT',
      ]),
    );
  });

  describe('per-account failed-login limit (shared by every API instance)', () => {
    const login = (password: string, app: App = server(), email = merchant.email) =>
      request(app).post('/v1/auth/login').send({ email, password, clientApp: 'MERCHANT_APP' });
    const failures = (reason: string) =>
      ctx.prisma.auditLog.count({
        where: { action: 'AUTH_LOGIN_FAILED', metadata: { path: ['reason'], equals: reason } },
      });
    async function lockOut() {
      for (let i = 0; i < 10; i += 1) await login(`wrong-password-${i}`).expect(401);
    }

    it('refuses even the right password after 10 wrong ones, exactly like a wrong password', async () => {
      await register().expect(201);
      await lockOut();
      const locked = await login(merchant.password).expect(401);
      const wrong = await login('wrong-password-x').expect(401);
      const unknown = await login(merchant.password, server(), 'nobody@example.com').expect(401);
      // Same answer for a locked account, a wrong password and an unknown email: no enumeration.
      expect(locked.body).toEqual(unknown.body);
      expect(wrong.body).toEqual(unknown.body);
      expect(locked.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(await failures('WRONG_PASSWORD')).toBe(10);
      // Attempts while locked are recorded but do not extend the lock.
      expect(await failures('LOCKED')).toBe(2);
      expect(await ctx.prisma.session.count()).toBe(1); // only the registration session
    });

    it('evaluates at most 10 wrong passwords under concurrent attempts on two API instances', async () => {
      await register().expect(201);
      const second = await createTestApp();
      try {
        const apps = [server(), second.app.getHttpServer() as App];
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) => login(`wrong-password-${i}`, apps[i % 2])),
        );
        expect(results.map((res) => res.status)).toEqual(Array(24).fill(401));
        expect(await failures('WRONG_PASSWORD')).toBeLessThanOrEqual(10);
        // Whatever the interleaving, the account locks at exactly 10, on either instance.
        while ((await failures('WRONG_PASSWORD')) < 10) await login('wrong-password-y', apps[1]);
        await login(merchant.password, apps[0]).expect(401);
        await login(merchant.password, apps[1]).expect(401);
        expect(await failures('WRONG_PASSWORD')).toBe(10);
      } finally {
        await second.app.close();
      }
    });

    it('lets the owner back in after a password change or when the window has passed', async () => {
      await register().expect(201);
      await lockOut();
      await login(merchant.password).expect(401);
      // A password change (for example a reset) starts a new count.
      await ctx.prisma.user.update({
        where: { email: merchant.email },
        data: { passwordChangedAt: new Date() },
      });
      await login(merchant.password).expect(200);

      await lockOut();
      await login(merchant.password).expect(401);
      // 15 minutes later the old failures no longer count (moved back in the test database).
      await ctx.prisma.$executeRaw`
        UPDATE audit_logs SET created_at = created_at - interval '16 minutes'
        WHERE action = 'AUTH_LOGIN_FAILED'`;
      await ctx.prisma.user.update({
        where: { email: merchant.email },
        data: { passwordChangedAt: new Date(Date.now() - 20 * 60_000) },
      });
      await login(merchant.password).expect(200);
    });
  });

  it('blocks unverified accounts from protected routes and non-admins from admin routes', async () => {
    const { body } = await register().expect(201);
    const auth = { Authorization: `Bearer ${body.token}` };
    const unverified = await request(server()).get('/v1/admin/users').set(auth).expect(403);
    expect(unverified.body.code).toBe('AUTH_EMAIL_NOT_VERIFIED');

    await request(server())
      .post('/v1/auth/verify-email')
      .send({ token: await ctx.mail.tokenFor(merchant.email) })
      .expect(200);
    const forbidden = await request(server()).get('/v1/admin/users').set(auth).expect(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
  });

  it('resets passwords without revealing whether an account exists', async () => {
    const { body } = await register().expect(201);
    const oldAuth = { Authorization: `Bearer ${body.token}` };

    await request(server())
      .post('/v1/auth/forgot-password')
      .send({ email: 'ghost@example.com' })
      .expect(202, { ok: true });
    await request(server())
      .post('/v1/auth/forgot-password')
      .send({ email: merchant.email })
      .expect(202, { ok: true });

    const token = await ctx.mail.tokenFor(merchant.email, 'كلمة مرور');
    expect(ctx.mail.sent.some((m) => m.to === 'ghost@example.com')).toBe(false);

    const weak = await request(server())
      .post('/v1/auth/reset-password')
      .send({ token, password: 'weak' })
      .expect(400);
    expect(weak.body.fieldErrors.password).toBe('validation.password.tooShort');

    await request(server())
      .post('/v1/auth/reset-password')
      .send({ token, password: 'brand-new-pass-456' })
      .expect(200);
    await request(server())
      .post('/v1/auth/reset-password')
      .send({ token, password: 'another-pass-789' })
      .expect(400);

    // Every existing session is revoked after a reset.
    await request(server()).get('/v1/auth/me').set(oldAuth).expect(401);
    await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: merchant.password, clientApp: 'MERCHANT_APP' })
      .expect(401);
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: 'brand-new-pass-456', clientApp: 'MERCHANT_APP' })
      .expect(200);
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('lets a SUPER_ADMIN invite a driver who then sets a password and signs in', async () => {
    await createSuperAdmin(ctx.prisma, 'root@example.com', 'root-admin-pass-1');
    const adminLogin = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'root@example.com', password: 'root-admin-pass-1', clientApp: 'ADMIN_WEB' })
      .expect(200);
    const admin = { Authorization: `Bearer ${adminLogin.body.token}` };

    const invalidRole = await request(server())
      .post('/v1/admin/users')
      .set(admin)
      .send({ fullName: 'Not Allowed', email: 'm@example.com', role: 'MERCHANT', language: 'en' })
      .expect(400);
    expect(invalidRole.body.fieldErrors.role).toBe('validation.role.invalid');

    const created = await request(server())
      .post('/v1/admin/users')
      .set(admin)
      .send({ fullName: 'Sami Driver', email: 'sami@example.com', role: 'DRIVER', language: 'en' })
      .expect(201);
    expect(created.body).toMatchObject({ role: 'DRIVER', emailVerified: false });

    const list = await request(server()).get('/v1/admin/users').set(admin).expect(200);
    expect(list.body.items).toHaveLength(2);

    // No password yet: login must fail like any wrong credential.
    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'sami@example.com', password: 'anything-123', clientApp: 'DRIVER_APP' })
      .expect(401);

    const setupToken = await ctx.mail.tokenFor('sami@example.com');
    expect(ctx.mail.sent.at(-1)?.text).toContain('http://localhost:8081/reset-password?token=');
    await request(server())
      .post('/v1/auth/reset-password')
      .send({ token: setupToken, password: 'driver-pass-123' })
      .expect(200);

    const driverLogin = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'sami@example.com', password: 'driver-pass-123', clientApp: 'DRIVER_APP' })
      .expect(200);
    expect(driverLogin.body.user).toMatchObject({ role: 'DRIVER', emailVerified: true });
    await request(server())
      .get('/v1/admin/users')
      .set({ Authorization: `Bearer ${driverLogin.body.token}` })
      .expect(403);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'USER_CREATED' } });
    expect(audit.actorUserId).toBe(adminLogin.body.user.id);
  });

  it('supports httpOnly cookie sessions with origin checks', async () => {
    await createSuperAdmin(ctx.prisma, 'root@example.com', 'root-admin-pass-1');
    const login = await request(server())
      .post('/v1/auth/login')
      .set('x-auth-transport', 'cookie')
      .send({ email: 'root@example.com', password: 'root-admin-pass-1', clientApp: 'ADMIN_WEB' })
      .expect(200);
    expect(login.body.token).toBeUndefined();
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/coobra_session=[A-Za-z0-9_-]+/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;

    await request(server()).get('/v1/auth/me').set('Cookie', cookie).expect(200);
    const csrf = await request(server())
      .post('/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(csrf.body.code).toBe('CSRF_ORIGIN_REJECTED');
    await request(server())
      .patch('/v1/me/preferences')
      .set('Cookie', cookie)
      .set('Origin', ALLOWED_ORIGIN)
      .send({ language: 'ar' })
      .expect(200)
      .expect((res) => expect(res.body.language).toBe('ar'));
    const logout = await request(server())
      .post('/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', ALLOWED_ORIGIN)
      .expect(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/coobra_session=;/);
    await request(server()).get('/v1/auth/me').set('Cookie', cookie).expect(401);
  });

  it('rejects disabled accounts and expired sessions', async () => {
    const { body } = await register().expect(201);
    await ctx.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(server())
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${body.token}` })
      .expect(401);

    await ctx.prisma.user.update({
      where: { email: merchant.email },
      data: { status: 'DISABLED' },
    });
    const disabled = await request(server())
      .post('/v1/auth/login')
      .send({ email: merchant.email, password: merchant.password, clientApp: 'MERCHANT_APP' })
      .expect(403);
    expect(disabled.body.code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

describe('Rate limiting (PostgreSQL integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('throttles repeated password reset requests', async () => {
    const send = () =>
      request(ctx.app.getHttpServer() as App)
        .post('/v1/auth/forgot-password')
        .send({ email: 'ghost@example.com' });
    for (let i = 0; i < 5; i++) await send().expect(202);
    const limited = await send().expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});
