import request from 'supertest';
import type { Server as App } from 'node:http';
import type { FinanceOverview } from '@coobra/shared';
import { runPhase2Backfill } from '../src/finance/phase2-backfill.js';
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

let keyCounter = 0;
const newKey = () => `report-key-${Date.now()}-${++keyCounter}`;

describe('Finance reports, reconciliation and Phase 2 backfill (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let ops: TestUser;
  let accountant: TestUser;
  let viewer: TestUser;
  let merchant: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}, key?: string) => {
      const req = request(server()).post(path).set('authorization', `Bearer ${user.token}`);
      if (key) req.set('idempotency-key', key);
      return req.send(body);
    },
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
    zones = await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  async function delivered(codAmount: string) {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount,
      })
      .expect(201);
    const id = created.body.id as string;
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    await api(driver)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: true, amount: codAmount, confirmed: true },
      })
      .expect(200);
    return id;
  }

  it('reports balances and a clean reconciliation, read-only for the owner', async () => {
    await delivered('200');
    const settlement = await api(driver)
      .post('/v1/driver/finance/settlements', { declaredAmount: '150' }, newKey())
      .expect(201);
    await api(accountant)
      .post(
        `/v1/admin/finance/settlements/${settlement.body.id}/confirm`,
        { countedAmount: '150', channel: 'HUB' },
        newKey(),
      )
      .expect(200);

    await api(ops).get('/v1/admin/finance/overview').expect(403);
    await api(merchant).get('/v1/admin/finance/overview').expect(403);
    const overview = (await api(viewer).get('/v1/admin/finance/overview').expect(200))
      .body as FinanceOverview;
    expect(overview).toMatchObject({
      companyCash: { HUB: '150.00', BANK: '0.00', EWALLET: '0.00' },
      driverCustody: '50.00',
      merchantPending: '50.00',
      merchantOwed: '135.00',
      merchantOwing: '0.00',
      period: { deliveryFees: '15.00', returnFees: '0.00' },
    });
    for (const check of overview.reconciliation) expect(check.difference).toBe('0.00');

    const journal = await api(viewer).get('/v1/admin/finance/journal?pageSize=10').expect(200);
    expect(journal.body.total).toBe(3);
    expect(journal.body.items[0].lines.length).toBeGreaterThanOrEqual(2);

    const csv = await api(viewer)
      .get('/v1/admin/finance/reports/merchant-balances.csv')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('merchant,pending_cod,balance,reserved,available');
    expect(csv.text).toContain('50.00,135.00,0.00,135.00');
    for (const name of ['driver-balances', 'journal', 'delivered-shipments']) {
      await api(accountant).get(`/v1/admin/finance/reports/${name}.csv`).expect(200);
    }
    await api(viewer).get('/v1/admin/finance/reports/users.csv').expect(404);
    await assertLedgerInvariants(ctx.prisma);
  });

  it('reports merchant debits and credits separately without changing the ledger', async () => {
    const approver = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc2@example.com');
    const adjust = async (type: string, amount: string, decision: 'approve' | 'reject' | null) => {
      const created = await api(accountant)
        .post('/v1/admin/finance/adjustments', {
          merchantId: merchant.id,
          type,
          amount,
          reason: `QA ${type} ${amount}`,
        })
        .expect(201);
      if (decision) {
        await api(approver)
          .post(
            `/v1/admin/finance/adjustments/${created.body.id}/${decision}`,
            decision === 'reject' ? { note: 'Not justified' } : {},
            newKey(),
          )
          .expect(200);
      }
    };
    await adjust('MERCHANT_CREDIT', '50', 'approve');
    await adjust('MERCHANT_DEBIT', '80', 'approve');
    await adjust('MERCHANT_DEBIT', '15', 'reject');
    await adjust('MERCHANT_CREDIT', '9', null);

    // The ledger keeps its net-account design: debits and credits unchanged.
    expect(await ledgerBalance(ctx.prisma, 'ADJUSTMENT_EXPENSE')).toBe('-30.00');
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-30.00');
    const lines = await ctx.prisma.journalLine.findMany({
      where: { entry: { kind: 'MERCHANT_ADJUSTMENT' } },
      include: { account: true },
    });
    expect(
      lines.map((line) => `${line.account.purpose}:${line.side}:${line.amount.toFixed(2)}`).sort(),
    ).toEqual([
      'ADJUSTMENT_EXPENSE:CREDIT:80.00',
      'ADJUSTMENT_EXPENSE:DEBIT:50.00',
      'MERCHANT_BALANCE:CREDIT:50.00',
      'MERCHANT_BALANCE:DEBIT:80.00',
    ]);

    // Reports: each direction as a positive amount, the net with its direction.
    const overview = (await api(viewer).get('/v1/admin/finance/overview').expect(200))
      .body as FinanceOverview;
    expect(overview.period.merchantAdjustments).toEqual({
      credits: '50.00',
      creditCount: 1,
      debits: '80.00',
      debitCount: 1,
      net: '-30.00',
    });
    expect(overview.period).not.toHaveProperty('adjustmentExpense');
    expect(overview.merchantOwing).toBe('30.00');
    const check = overview.reconciliation.find((item) => item.key === 'MERCHANT_ADJUSTMENTS');
    expect(check).toEqual({
      key: 'MERCHANT_ADJUSTMENTS',
      ledger: '-30.00',
      operational: '-30.00',
      difference: '0.00',
    });
    for (const item of overview.reconciliation) expect(item.difference).toBe('0.00');

    // A period without adjustments shows zeros, not the all-time totals.
    const future = (
      await api(viewer).get('/v1/admin/finance/overview?from=2999-01-01T00:00:00.000Z').expect(200)
    ).body as FinanceOverview;
    expect(future.period.merchantAdjustments).toMatchObject({ credits: '0.00', debits: '0.00' });

    const csv = await api(viewer)
      .get('/v1/admin/finance/reports/merchant-adjustments.csv')
      .expect(200);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(rows[0]).toBe(
      'requested_at,decided_at,merchant,type,direction,amount,status,reason,requested_by,decided_by,journal_entry_id',
    );
    const body = rows.slice(1).map((row) => row.split(',').slice(3, 7).join(','));
    expect(body).toEqual([
      'MERCHANT_CREDIT,credit_to_merchant,50.00,APPLIED',
      'MERCHANT_DEBIT,debit_to_merchant,80.00,APPLIED',
      'MERCHANT_DEBIT,debit_to_merchant,15.00,REJECTED',
      'MERCHANT_CREDIT,credit_to_merchant,9.00,PENDING_APPROVAL',
    ]);
    // No amount is ever negative in the export.
    expect(rows.slice(1).every((row) => !row.split(',')[5]!.startsWith('-'))).toBe(true);
    await api(merchant).get('/v1/admin/finance/reports/merchant-adjustments.csv').expect(403);
    await api(ops).get('/v1/admin/finance/reports/merchant-adjustments.csv').expect(403);
    await assertLedgerInvariants(ctx.prisma);
  });

  it('backfills Phase 2 records only on execute, exactly once', async () => {
    // Simulate Phase 2 data: delivered with a collection record, written before the ledger existed.
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount: '150',
      })
      .expect(201);
    const id = created.body.id as string;
    await ctx.prisma.shipment.update({
      where: { id },
      data: {
        status: 'DELIVERED',
        driverId: driver.id,
        deliveredAt: new Date(),
        codCollectedAmount: '150',
        codStatus: 'COLLECTED',
      },
    });
    await ctx.prisma.codCollection.create({
      data: {
        shipmentId: id,
        driverId: driver.id,
        collected: true,
        expectedAmount: '150',
        collectedAmount: '150',
      },
    });
    expect(await ctx.prisma.journalEntry.count()).toBe(0);

    // Unposted legacy cash is not custody yet: it can be neither declared nor cleared.
    const before = await api(driver).get('/v1/driver/finance').expect(200);
    expect(before.body).toMatchObject({ custody: '0.00', uncleared: [] });
    expect(
      (
        await api(driver)
          .post('/v1/driver/finance/settlements', { declaredAmount: '150' }, newKey())
          .expect(422)
      ).body.code,
    ).toBe('INSUFFICIENT_FUNDS');

    // Not hidden either: the overview counts what the backfill would post.
    const pending = (await api(viewer).get('/v1/admin/finance/overview').expect(200))
      .body as FinanceOverview;
    expect(pending.queues).toMatchObject({ legacyCollectionsUnposted: 1, legacyFeesUnposted: 1 });
    for (const check of pending.reconciliation) expect(check.difference).toBe('0.00');

    const dryRun = await runPhase2Backfill(ctx.prisma, { execute: false });
    expect(dryRun).toMatchObject({
      executed: false,
      totals: { collections: '150.00', fees: '15.00' },
    });
    expect(dryRun.fees[0]?.shipmentId).toBe(id);
    expect(await ctx.prisma.journalEntry.count()).toBe(0);

    const executed = await runPhase2Backfill(ctx.prisma, { execute: true });
    expect(executed.collections).toHaveLength(1);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'PHASE2_BACKFILL' } })).toBe(2);
    expect(await ledgerBalance(ctx.prisma, `DRIVER_CUSTODY:${driver.id}`)).toBe('150.00');
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-15.00');
    const posted = (await api(viewer).get('/v1/admin/finance/overview').expect(200))
      .body as FinanceOverview;
    expect(posted.queues).toMatchObject({ legacyCollectionsUnposted: 0, legacyFeesUnposted: 0 });

    const after = await api(driver).get('/v1/driver/finance').expect(200);
    expect(after.body.custody).toBe('150.00');
    expect(after.body.uncleared).toHaveLength(1);
    await api(driver)
      .post('/v1/driver/finance/settlements', { declaredAmount: '150' }, newKey())
      .expect(201);

    // A second run finds nothing left: no double counting.
    const again = await runPhase2Backfill(ctx.prisma, { execute: true });
    expect(again.collections).toHaveLength(0);
    expect(again.fees).toHaveLength(0);
    expect(await ctx.prisma.journalEntry.count()).toBe(2);
    await assertLedgerInvariants(ctx.prisma);
  });

  it('reverses a backfilled fee when it is corrected, never charging twice', async () => {
    const admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount: '0',
      })
      .expect(201);
    const id = created.body.id as string;
    await ctx.prisma.shipment.update({
      where: { id },
      data: { status: 'DELIVERED', driverId: driver.id, deliveredAt: new Date() },
    });
    await runPhase2Backfill(ctx.prisma, { execute: true });
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-15.00');

    const requested = await api(accountant)
      .post(`/v1/admin/finance/shipments/${id}/fee-correction`, {
        fee: '10',
        reason: 'Agreed discount',
      })
      .expect(201);
    await api(admin)
      .post(`/v1/admin/finance/fee-corrections/${requested.body.id}/approve`, {}, newKey())
      .expect(200);

    const backfilled = await ctx.prisma.journalEntry.findFirstOrThrow({
      where: { kind: 'PHASE2_BACKFILL', sourceType: 'shipment_fee' },
    });
    const reversal = await ctx.prisma.journalEntry.findFirstOrThrow({
      where: { kind: 'REVERSAL' },
    });
    expect(reversal.reversalOfId).toBe(backfilled.id);
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-10.00');
    expect(await ledgerBalance(ctx.prisma, 'DELIVERY_FEE_REVENUE')).toBe('10.00');
    await assertLedgerInvariants(ctx.prisma);
  });
});
