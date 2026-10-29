import request from 'supertest';
import type { Server as App } from 'node:http';
import type { AuditLogDetails, AuditLogListItem, Paginated } from '@coobra/shared';
import { AuditLogService } from '../src/audit/audit-log.service.js';
import {
  createSignedInUser,
  createTestApp,
  resetDatabase,
  type TestContext,
  type TestUser,
} from './helpers.js';

const SHIPMENT = '0199a1c2-7d3e-7f00-8000-0000000000aa';
const SETTLEMENT = '0199a1c2-7d3e-7f00-8000-0000000000bb';
const SECRETS = [
  'hunter2',
  'sk_live_abc',
  '$argon2id$v=19$m=1',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x',
];

describe('Audit log viewer (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let driver: TestUser;
  let merchant: TestUser;
  const server = () => ctx.app.getHttpServer() as App;
  const get = (user: TestUser, path: string) =>
    request(server()).get(path).set('authorization', `Bearer ${user.token}`);
  const list = async (query = '') =>
    (await get(admin, `/v1/admin/audit-logs${query}`).expect(200))
      .body as Paginated<AuditLogListItem>;
  /** Fingerprint of every audit row, to prove reads change nothing. */
  const fingerprint = async () =>
    (
      await ctx.prisma.$queryRaw<{ fp: string }[]>`
        SELECT count(*)::text || ':' || md5(coalesce(string_agg(r::text, '|' ORDER BY r.id), '')) AS fp
        FROM audit_logs r`
    )[0]!.fp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com', {
      fullName: 'Root Admin',
    });
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com', { fullName: 'Sami Ops' });
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    viewer = await createSignedInUser(ctx, 'OWNER_VIEWER', 'owner@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'driver@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'shop@example.com');
    // Each sign-in above wrote AUTH_LOGIN_SUCCEEDED (6 rows). Add entries with known times.
    const at = (iso: string) => new Date(iso);
    await ctx.prisma.auditLog.createMany({
      data: [
        {
          action: 'SHIPMENT_STATUS_CHANGED',
          actorUserId: ops.id,
          targetUserId: merchant.id,
          metadata: {
            shipmentId: SHIPMENT,
            trackingNumber: 'CB-12345678',
            fromStatus: 'CREATED',
            toStatus: 'ASSIGNED',
          },
          createdAt: at('2026-10-01T08:00:00.000Z'),
        },
        {
          action: 'SETTLEMENT_CONFIRMED',
          actorUserId: accountant.id,
          targetUserId: driver.id,
          metadata: { settlementId: SETTLEMENT, countedAmount: '120.00', channel: 'HUB' },
          createdAt: at('2026-10-02T08:00:00.000Z'),
        },
        {
          action: 'DRIVER_REPAYMENT_RECORDED',
          actorUserId: accountant.id,
          targetUserId: driver.id,
          metadata: { receiptReference: 'RC-1001', amount: '4.00' },
          createdAt: at('2026-10-03T08:00:00.000Z'),
        },
        {
          // Planted secrets: none may ever come back.
          action: 'USER_PROFILE_UPDATED',
          actorUserId: admin.id,
          targetUserId: ops.id,
          ipAddress: '203.0.113.7',
          userAgent: 'Test agent',
          metadata: {
            before: { fullName: 'Sami', password: 'hunter2' },
            after: { fullName: 'Sami Ops', nested: { apiKey: 'sk_live_abc' } },
            passwordHash: '$argon2id$v=19$m=1',
            note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x',
            reason: 'Name fix',
          },
          createdAt: at('2026-10-04T08:00:00.000Z'),
        },
      ],
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('is SUPER_ADMIN only, at the route and in the service', async () => {
    const [entry] = (await list()).items;
    for (const user of [ops, accountant, viewer, driver, merchant]) {
      await get(user, '/v1/admin/audit-logs').expect(403);
      await get(user, `/v1/admin/audit-logs/${entry!.id}`).expect(403);
    }
    await request(server()).get('/v1/admin/audit-logs').expect(401);
    await expect(
      ctx.app
        .get(AuditLogService)
        .list({ id: ops.id, role: 'OPERATIONS' }, { page: 1, pageSize: 25 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is read only and leaves every audit record unchanged', async () => {
    const before = await fingerprint();
    const [entry] = (await list()).items;
    await get(admin, `/v1/admin/audit-logs/${entry!.id}`).expect(200);
    await list('?q=CB-12345678&category=SHIPMENTS');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const call = (path: string) =>
        request(server())[method](path).set('authorization', `Bearer ${admin.token}`);
      await call('/v1/admin/audit-logs').send({}).expect(404);
      await call(`/v1/admin/audit-logs/${entry!.id}`).send({ action: 'X' }).expect(404);
    }
    expect(await fingerprint()).toBe(before);
  });

  it('pages newest first with a stable order, also for equal timestamps', async () => {
    const same = new Date('2026-09-15T10:00:00.000Z');
    await ctx.prisma.auditLog.createMany({
      data: Array.from({ length: 7 }, () => ({ action: 'AUTH_LOGOUT', createdAt: same })),
    });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await list(`?action=AUTH_LOGOUT&pageSize=3&page=${page}`);
      expect(res.total).toBe(7);
      seen.push(...res.items.map((item) => item.id));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort().reverse());

    const all = (await list('?pageSize=100')).items;
    const times = all.map((item) => item.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(all[0]!.action).toBe('AUTH_LOGIN_SUCCEEDED'); // written just now
  });

  it('filters by action, category, people, entity and dates, alone and combined', async () => {
    const ids = async (query: string) => (await list(query)).items.map((item) => item.action);
    expect(await ids('?action=SETTLEMENT_CONFIRMED')).toEqual(['SETTLEMENT_CONFIRMED']);
    expect(await ids('?category=FINANCE')).toEqual([
      'DRIVER_REPAYMENT_RECORDED',
      'SETTLEMENT_CONFIRMED',
    ]);
    expect(await ids(`?actorId=${accountant.id}&category=FINANCE`)).toHaveLength(2);
    expect(await ids(`?targetUserId=${driver.id}&action=SETTLEMENT_CONFIRMED`)).toEqual([
      'SETTLEMENT_CONFIRMED',
    ]);
    expect(await ids(`?entityType=SHIPMENT&entityId=${SHIPMENT}`)).toEqual([
      'SHIPMENT_STATUS_CHANGED',
    ]);
    expect(await ids('?entityType=SETTLEMENT')).toEqual(['SETTLEMENT_CONFIRMED']);
    expect(await ids(`?entityType=USER&entityId=${ops.id}`)).toContain('USER_PROFILE_UPDATED');
    expect(await ids('?entityType=USER&entityId=not-a-uuid')).toEqual([]);
    const range = '?from=2026-10-02T00:00:00.000Z&to=2026-10-04T00:00:00.000Z';
    expect(await ids(range)).toEqual(['DRIVER_REPAYMENT_RECORDED', 'SETTLEMENT_CONFIRMED']);
    // The end is exclusive and offsets are compared as instants.
    expect(await ids('?from=2026-10-04T11:00:00%2B03:00&to=2026-10-04T11:00:01%2B03:00')).toEqual([
      'USER_PROFILE_UPDATED',
    ]);
    expect(await ids(`${range}&actorId=${ops.id}`)).toEqual([]);

    const items = (await list(`?entityType=SHIPMENT&entityId=${SHIPMENT}`)).items;
    expect(items[0]).toMatchObject({
      category: 'SHIPMENTS',
      entity: { type: 'SHIPMENT', id: SHIPMENT },
      summary: 'CB-12345678',
      actor: { id: ops.id, fullName: 'Sami Ops', role: 'OPERATIONS' },
      targetUser: { id: merchant.id, role: 'MERCHANT' },
    });
  });

  it('searches by id, tracking number, receipt reference and person', async () => {
    const actions = async (q: string) =>
      (await list(`?q=${encodeURIComponent(q)}`)).items.map((item) => item.action);
    expect(await actions(SHIPMENT.toUpperCase())).toEqual(['SHIPMENT_STATUS_CHANGED']);
    expect(await actions('cb-12345678')).toEqual(['SHIPMENT_STATUS_CHANGED']);
    expect(await actions('rc-1001')).toEqual(['DRIVER_REPAYMENT_RECORDED']);
    const [entry] = (await list('?action=SETTLEMENT_CONFIRMED')).items;
    expect(await actions(entry!.id)).toEqual(['SETTLEMENT_CONFIRMED']);
    // A person (name or email) matches entries they did or that were about them.
    expect(await actions('sami')).toEqual(
      expect.arrayContaining(['USER_PROFILE_UPDATED', 'SHIPMENT_STATUS_CHANGED']),
    );
    expect(await actions('acc@example')).toEqual(
      expect.arrayContaining(['DRIVER_REPAYMENT_RECORDED', 'SETTLEMENT_CONFIRMED']),
    );
    expect(await actions('nobody-matches-this')).toEqual([]);
  });

  it('rejects invalid dates, ranges, limits and filters', async () => {
    const bad = async (query: string, field: string, key: string) => {
      const res = await get(admin, `/v1/admin/audit-logs${query}`).expect(400);
      expect(res.body.fieldErrors?.[field]).toBe(key);
    };
    await bad('?from=yesterday', 'from', 'validation.audit.date');
    await bad('?to=2026-13-01T00:00:00Z', 'to', 'validation.audit.date');
    await bad(
      '?from=2026-10-05T00:00:00.000Z&to=2026-10-01T00:00:00.000Z',
      'to',
      'validation.audit.dateRange',
    );
    await bad('?entityId=abc', 'entityType', 'validation.audit.entityType');
    await bad('?action=DROP_TABLE', 'action', 'validation.audit.action');
    await bad('?actorId=1;DROP', 'actorId', 'validation.audit.id');
    await get(admin, '/v1/admin/audit-logs?pageSize=101').expect(400);
    await get(admin, '/v1/admin/audit-logs?page=0').expect(400);
    await get(admin, `/v1/admin/audit-logs?q=${'x'.repeat(101)}`).expect(400);
    // Quotes and JSON in a search are data, not SQL or JSON syntax.
    expect((await list(`?q=${encodeURIComponent(`x' OR '1'='1`)}`)).items).toEqual([]);
    expect((await list(`?q=${encodeURIComponent('{"a":1}')}`)).items).toEqual([]);
  });

  it('returns one entry with its changes, request details and nothing secret', async () => {
    const [entry] = (await list('?action=USER_PROFILE_UPDATED')).items;
    const res = await get(admin, `/v1/admin/audit-logs/${entry!.id}`).expect(200);
    const details = res.body as AuditLogDetails;
    expect(details).toMatchObject({
      action: 'USER_PROFILE_UPDATED',
      category: 'USERS',
      ipAddress: '203.0.113.7',
      userAgent: 'Test agent',
      entity: { type: 'USER', id: ops.id },
      details: { reason: 'Name fix', passwordHash: '[redacted]', note: '[redacted]' },
    });
    expect(details.changes).toEqual(
      expect.arrayContaining([
        { field: 'fullName', before: 'Sami', after: 'Sami Ops' },
        { field: 'password', before: '[redacted]', after: null },
        { field: 'nested', before: null, after: { apiKey: '[redacted]' } },
      ]),
    );
    expect(details.redacted.sort()).toEqual(
      ['passwordHash', 'before.password', 'after.nested.apiKey', 'note'].sort(),
    );
    // Neither the detail nor any list page carries a secret, an IP or a user agent.
    const pages = [res.text, (await get(admin, '/v1/admin/audit-logs?pageSize=100')).text];
    for (const text of pages) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(pages[1]).not.toContain('203.0.113.7');
    expect(pages[1]).not.toContain('Test agent');

    await get(admin, '/v1/admin/audit-logs/0199a1c2-7d3e-7f00-8000-00000000ffff').expect(404);
    await get(admin, '/v1/admin/audit-logs/not-a-uuid').expect(404);
  });

  it('applies the same redaction to the user history', async () => {
    const res = await get(admin, `/v1/admin/users/${ops.id}`).expect(200);
    for (const secret of SECRETS) expect(res.text).not.toContain(secret);
    expect(res.text).toContain('Name fix');
  });
});
