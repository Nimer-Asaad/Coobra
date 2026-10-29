import request from 'supertest';
import type { Server as App } from 'node:http';
import type { Paginated, UserDetails, UserListItem } from '@coobra/shared';
import { UserAdminService } from '../src/users/user-admin.service.js';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  TEST_PASSWORD,
  type TestContext,
  type TestUser,
} from './helpers.js';

describe('User management (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let admin2: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let driver: TestUser;
  let merchant: TestUser;
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
    patch: (path: string, body: object = {}) =>
      request(server()).patch(path).set('authorization', `Bearer ${user.token}`).send(body),
  });
  const details = async (id: string) =>
    (await api(admin).get(`/v1/admin/users/${id}`).expect(200)).body as UserDetails;
  const version = async (id: string) => (await details(id)).updatedAt;
  const signIn = (email: string, clientApp = 'ADMIN_WEB') =>
    request(server()).post('/v1/auth/login').send({ email, password: TEST_PASSWORD, clientApp });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com', {
      fullName: 'Root Admin',
    });
    admin2 = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin2@example.com', {
      fullName: 'Second Admin',
    });
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com', {
      fullName: 'سامي العمليات',
      phone: '0599000001',
    });
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'driver@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'shop@example.com', {
      businessName: 'Jenin Sweets',
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('is SUPER_ADMIN only, for every route', async () => {
    const reason = { reason: 'Not allowed', expectedUpdatedAt: new Date().toISOString() };
    for (const user of [ops, accountant, viewer, driver, merchant]) {
      await api(user).get('/v1/admin/users').expect(403);
      await api(user).get(`/v1/admin/users/${ops.id}`).expect(403);
      await api(user)
        .patch(`/v1/admin/users/${ops.id}`, { fullName: 'X Y', ...reason })
        .expect(403);
      await api(user).post(`/v1/admin/users/${ops.id}/deactivate`, reason).expect(403);
      await api(user).post(`/v1/admin/users/${ops.id}/reactivate`, reason).expect(403);
      await api(user)
        .post(`/v1/admin/users/${ops.id}/role`, { role: 'ACCOUNTANT', ...reason })
        .expect(403);
    }
    // The service refuses on its own too (no reliance on the route guard alone).
    const service = ctx.app.get(UserAdminService);
    await expect(
      service.list({ id: ops.id, role: 'OPERATIONS' }, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'USER_' } } })).toBe(0);
  });

  it('lists with pagination, search and filters, never exposing secrets', async () => {
    const page1 = (await api(admin).get('/v1/admin/users?pageSize=3').expect(200))
      .body as Paginated<UserListItem>;
    expect(page1).toMatchObject({ page: 1, pageSize: 3, total: 7 });
    expect(page1.items).toHaveLength(3);
    const page3 = (await api(admin).get('/v1/admin/users?pageSize=3&page=3').expect(200))
      .body as Paginated<UserListItem>;
    expect(page3.items).toHaveLength(1);
    const all = [...page1.items];
    for (let page = 2; page <= 3; page++) {
      all.push(
        ...((await api(admin).get(`/v1/admin/users?pageSize=3&page=${page}`).expect(200)).body
          .items as UserListItem[]),
      );
    }
    expect(new Set(all.map((user) => user.id)).size).toBe(7);

    const search = async (query: string) =>
      (
        (await api(admin).get(`/v1/admin/users?${query}`).expect(200))
          .body as Paginated<UserListItem>
      ).items.map((user) => user.email);
    expect(await search('q=ADMIN2')).toEqual(['admin2@example.com']);
    expect(await search(`q=${encodeURIComponent('سامي')}`)).toEqual(['ops@example.com']);
    expect(await search('q=0599000001')).toEqual(['ops@example.com']);
    expect(await search('q=jenin')).toEqual(['shop@example.com']);
    expect((await search('role=SUPER_ADMIN')).sort()).toEqual([
      'admin2@example.com',
      'admin@example.com',
    ]);
    expect(await search('status=DISABLED')).toEqual([]);
    await api(admin).get('/v1/admin/users?role=KING').expect(400);
    await api(admin).get('/v1/admin/users?pageSize=500').expect(400);

    const merchantRow = all.find((user) => user.id === merchant.id);
    expect(merchantRow).toMatchObject({ businessName: 'Jenin Sweets', role: 'MERCHANT' });
    const raw = JSON.stringify(
      (await api(admin).get(`/v1/admin/users/${merchant.id}`).expect(200)).body,
    );
    for (const secret of ['passwordHash', 'password_hash', '$argon2', 'tokenHash', TEST_PASSWORD]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.stringify(all)).not.toContain('$argon2');
  });

  it('edits permitted profile fields with a version check and an audit trail', async () => {
    const before = await details(ops.id);
    const edited = (
      await api(admin)
        .patch(`/v1/admin/users/${ops.id}`, {
          fullName: 'Sami Operations',
          phone: '٠٥٩٩٧٧٧٨٨٨',
          language: 'ar',
          expectedUpdatedAt: before.updatedAt,
        })
        .expect(200)
    ).body as UserDetails;
    expect(edited).toMatchObject({
      fullName: 'Sami Operations',
      phone: '0599777888',
      language: 'ar',
      role: 'OPERATIONS',
      email: 'ops@example.com',
    });
    // The old version is stale now.
    expect(
      (
        await api(admin)
          .patch(`/v1/admin/users/${ops.id}`, {
            fullName: 'Lost update',
            expectedUpdatedAt: before.updatedAt,
          })
          .expect(409)
      ).body.code,
    ).toBe('USER_CHANGED');
    expect(edited.history[0]).toMatchObject({
      action: 'USER_PROFILE_UPDATED',
      actor: { id: admin.id },
      metadata: {
        before: { fullName: 'سامي العمليات', phone: '0599000001', language: 'en' },
        after: { fullName: 'Sami Operations', phone: '0599777888', language: 'ar' },
      },
    });

    // Business name is a merchant field; other fields are validated; email is not editable.
    const fieldErrors = async (id: string, body: object) =>
      (
        await api(admin)
          .patch(`/v1/admin/users/${id}`, { expectedUpdatedAt: await version(id), ...body })
          .expect(400)
      ).body.fieldErrors;
    expect(await fieldErrors(ops.id, { businessName: 'Shop' })).toEqual({
      businessName: 'validation.user.merchantOnly',
    });
    expect(await fieldErrors(ops.id, { phone: '12' })).toEqual({
      phone: 'validation.phone.invalid',
    });
    expect(await fieldErrors(ops.id, {})).toEqual({ fullName: 'validation.user.nothingToChange' });
    await api(admin)
      .patch(`/v1/admin/users/${ops.id}`, {
        email: 'evil@example.com',
        fullName: 'Sami Ops',
        expectedUpdatedAt: await version(ops.id),
      })
      .expect(200);
    expect((await details(ops.id)).email).toBe('ops@example.com');

    const shop = (
      await api(admin)
        .patch(`/v1/admin/users/${merchant.id}`, {
          businessName: 'Jenin Sweets & Co',
          phone: '',
          expectedUpdatedAt: await version(merchant.id),
        })
        .expect(200)
    ).body as UserDetails;
    expect(shop).toMatchObject({ merchant: { businessName: 'Jenin Sweets & Co' }, phone: null });
    // A profile edit is not a security change: the merchant stays signed in.
    await api(merchant).get('/v1/auth/me').expect(200);
  });

  it('deactivates (signing the user out everywhere) and reactivates with reasons', async () => {
    const second = await signIn('driver@example.com', 'DRIVER_APP').expect(200);
    const res = await api(admin)
      .post(`/v1/admin/users/${driver.id}/deactivate`, {
        reason: 'Left the company',
        expectedUpdatedAt: await version(driver.id),
      })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'DISABLED', activeSessions: 0 });
    // Both of the driver's sessions are gone and a new sign-in is refused.
    await api(driver).get('/v1/auth/me').expect(401);
    await request(server())
      .get('/v1/auth/me')
      .set('authorization', `Bearer ${second.body.token}`)
      .expect(401);
    expect((await signIn('driver@example.com', 'DRIVER_APP').expect(403)).body.code).toBe(
      'AUTH_ACCOUNT_DISABLED',
    );
    // Deactivating twice is a conflict, not a silent no-op.
    await api(admin)
      .post(`/v1/admin/users/${driver.id}/deactivate`, {
        reason: 'Again',
        expectedUpdatedAt: await version(driver.id),
      })
      .expect(409);
    await api(admin)
      .post(`/v1/admin/users/${driver.id}/deactivate`, {
        expectedUpdatedAt: await version(driver.id),
      })
      .expect(400);

    await api(admin)
      .post(`/v1/admin/users/${driver.id}/reactivate`, {
        reason: 'Rehired',
        expectedUpdatedAt: await version(driver.id),
      })
      .expect(200);
    await signIn('driver@example.com', 'DRIVER_APP').expect(200);

    const actions = await ctx.prisma.auditLog.findMany({
      where: { targetUserId: driver.id, action: { in: ['USER_DEACTIVATED', 'USER_REACTIVATED'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((entry) => [entry.action, entry.actorUserId, entry.metadata])).toEqual([
      [
        'USER_DEACTIVATED',
        admin.id,
        { reason: 'Left the company', role: 'DRIVER', sessionsRevoked: 2 },
      ],
      ['USER_REACTIVATED', admin.id, { reason: 'Rehired', role: 'DRIVER', sessionsRevoked: 0 }],
    ]);
  });

  it('changes staff roles only, and signs the user out to apply them', async () => {
    const changed = (
      await api(admin)
        .post(`/v1/admin/users/${ops.id}/role`, {
          role: 'ACCOUNTANT',
          reason: 'Moved to finance',
          expectedUpdatedAt: await version(ops.id),
        })
        .expect(200)
    ).body as UserDetails;
    expect(changed).toMatchObject({ role: 'ACCOUNTANT', activeSessions: 0 });
    await api(ops).get('/v1/auth/me').expect(401);
    const fresh = await signIn('ops@example.com').expect(200);
    expect(fresh.body.user.role).toBe('ACCOUNTANT');
    expect(changed.history[0]).toMatchObject({
      action: 'USER_ROLE_CHANGED',
      metadata: {
        from: 'OPERATIONS',
        to: 'ACCOUNTANT',
        reason: 'Moved to finance',
        sessionsRevoked: 1,
      },
    });

    // Drivers and merchants own ledger accounts: their role never changes.
    for (const user of [driver, merchant]) {
      expect(
        (
          await api(admin)
            .post(`/v1/admin/users/${user.id}/role`, {
              role: 'OPERATIONS',
              reason: 'Promotion',
              expectedUpdatedAt: await version(user.id),
            })
            .expect(422)
        ).body.code,
      ).toBe('USER_ROLE_NOT_CHANGEABLE');
    }
    // Nobody becomes a driver or merchant through a role change, and a no-op is refused.
    await api(admin)
      .post(`/v1/admin/users/${viewer.id}/role`, {
        role: 'DRIVER',
        reason: 'Drive',
        expectedUpdatedAt: await version(viewer.id),
      })
      .expect(400);
    await api(admin)
      .post(`/v1/admin/users/${viewer.id}/role`, {
        role: 'OWNER_VIEWER',
        reason: 'Same',
        expectedUpdatedAt: await version(viewer.id),
      })
      .expect(409);
  });

  it('never lets an administrator deactivate or demote their own account', async () => {
    for (const [path, body] of [
      ['deactivate', { reason: 'Leaving' }],
      ['role', { role: 'OPERATIONS', reason: 'Step down' }],
    ] as const) {
      const res = await api(admin)
        .post(`/v1/admin/users/${admin.id}/${path}`, {
          ...body,
          expectedUpdatedAt: await version(admin.id),
        })
        .expect(403);
      expect(res.body.code).toBe('USER_SELF_CHANGE_FORBIDDEN');
    }
    expect((await details(admin.id)).role).toBe('SUPER_ADMIN');
    // Editing one's own profile is fine.
    await api(admin)
      .patch(`/v1/admin/users/${admin.id}`, {
        fullName: 'Root Administrator',
        expectedUpdatedAt: await version(admin.id),
      })
      .expect(200);
  });

  it('never removes the last active SUPER_ADMIN, even under concurrent changes', async () => {
    // Two super admins demote and deactivate each other at the same moment: one must remain.
    const [a, b] = await Promise.all([
      api(admin).post(`/v1/admin/users/${admin2.id}/role`, {
        role: 'OPERATIONS',
        reason: 'Restructure',
        expectedUpdatedAt: await version(admin2.id),
      }),
      api(admin2).post(`/v1/admin/users/${admin.id}/deactivate`, {
        reason: 'Restructure',
        expectedUpdatedAt: await version(admin.id),
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.code, b.body.code]).toContain('LAST_SUPER_ADMIN');
    expect(await ctx.prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(
      1,
    );

    // Directly at the service level, the remaining super admin cannot be removed either.
    const remaining = await ctx.prisma.user.findFirstOrThrow({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    });
    const service = ctx.app.get(UserAdminService);
    const outsider = { id: '0199a1c2-7d3e-7f00-8000-00000000abcd', role: 'SUPER_ADMIN' as const };
    const meta = { ipAddress: null, userAgent: null };
    await expect(
      service.setActive(
        outsider,
        remaining.id,
        false,
        { reason: 'Test', expectedUpdatedAt: remaining.updatedAt.toISOString() },
        meta,
      ),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    await expect(
      service.changeRole(
        outsider,
        remaining.id,
        {
          role: 'ACCOUNTANT',
          reason: 'Test',
          expectedUpdatedAt: remaining.updatedAt.toISOString(),
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
  });

  it('lets exactly one of two concurrent edits of the same version win', async () => {
    const seen = await version(viewer.id);
    const [a, b] = await Promise.all([
      api(admin).patch(`/v1/admin/users/${viewer.id}`, {
        fullName: 'Owner One',
        expectedUpdatedAt: seen,
      }),
      api(admin2).patch(`/v1/admin/users/${viewer.id}`, {
        fullName: 'Owner Two',
        expectedUpdatedAt: seen,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? 'Owner One' : 'Owner Two';
    expect((await details(viewer.id)).fullName).toBe(winner);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'USER_PROFILE_UPDATED', targetUserId: viewer.id },
      }),
    ).toBe(1);
  });

  it('returns 404 for unknown users and keeps financial tables untouched', async () => {
    await api(admin).get('/v1/admin/users/not-a-uuid').expect(404);
    await api(admin).get('/v1/admin/users/0199a1c2-7d3e-7f00-8000-00000000ffff').expect(404);
    await api(admin)
      .post(`/v1/admin/users/${driver.id}/deactivate`, {
        reason: 'Audit',
        expectedUpdatedAt: await version(driver.id),
      })
      .expect(200);
    expect(await ctx.prisma.journalEntry.count()).toBe(0);
    expect(await ctx.prisma.financialAccount.count()).toBe(0);
  });
});
