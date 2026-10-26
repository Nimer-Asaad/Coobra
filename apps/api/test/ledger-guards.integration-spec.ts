import request from 'supertest';
import type { Server as App } from 'node:http';
import { runPhase2Backfill } from '../src/finance/phase2-backfill.js';
import { accounts, credit, debit, LedgerService } from '../src/finance/ledger.service.js';
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

describe('Database guards against duplicate COD and fee postings (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let ops: TestUser;
  let merchant: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const ledger = new LedgerService();
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'm@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    zones = await setupBasicPricing(ctx.prisma, [merchant.id]);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  async function createShipment(codAmount: string) {
    const created = await api(merchant)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId: zones.ramallah,
        addressLine: 'Street 1',
        codAmount,
      })
      .expect(201);
    return created.body.id as string;
  }

  /** A Phase 2 style delivery: collection recorded, nothing posted to the ledger. */
  async function legacyDelivery(codAmount: string) {
    const id = await createShipment(codAmount);
    await ctx.prisma.shipment.update({
      where: { id },
      data: {
        status: 'DELIVERED',
        driverId: driver.id,
        deliveredAt: new Date(),
        codCollectedAmount: codAmount,
        codStatus: 'COLLECTED',
      },
    });
    const collection = await ctx.prisma.codCollection.create({
      data: {
        shipmentId: id,
        driverId: driver.id,
        collected: true,
        expectedAmount: codAmount,
        collectedAmount: codAmount,
      },
    });
    return { shipmentId: id, collectionId: collection.id };
  }

  const postCollection = (kind: 'COD_COLLECTION' | 'PHASE2_BACKFILL', collectionId: string) =>
    ctx.prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind,
        sourceType: 'cod_collection',
        sourceId: collectionId,
        createdById: null,
        description: `test ${kind}`,
        lines: [
          debit(accounts.driverCustody(driver.id), '150'),
          credit(accounts.merchantPending(merchant.id), '150'),
        ],
      }),
    );

  it('rejects a backfill posting for a collection the live path already posted', async () => {
    const id = await createShipment('150');
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    for (const toStatus of ['PICKED_UP', 'OUT_FOR_DELIVERY']) {
      await api(driver).post(`/v1/driver/shipments/${id}/transitions`, { toStatus }).expect(200);
    }
    await api(driver)
      .post(`/v1/driver/shipments/${id}/transitions`, {
        toStatus: 'DELIVERED',
        cod: { collected: true, amount: '150', confirmed: true },
      })
      .expect(200);
    const collection = await ctx.prisma.codCollection.findFirstOrThrow({
      where: { shipmentId: id },
    });

    await expect(postCollection('PHASE2_BACKFILL', collection.id)).rejects.toThrow(
      'This was already posted',
    );
    // The same guard covers the delivery fee posted on delivery.
    await expect(
      ctx.prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: 'PHASE2_BACKFILL',
          sourceType: 'shipment_fee',
          sourceId: id,
          createdById: null,
          description: 'test duplicate fee',
          lines: [
            debit(accounts.merchantBalance(merchant.id), '15', id),
            credit(accounts.deliveryFeeRevenue(), '15', id),
          ],
        }),
      ),
    ).rejects.toThrow('This was already posted');
    expect(await ledgerBalance(ctx.prisma, `DRIVER_CUSTODY:${driver.id}`)).toBe('150.00');
    await assertLedgerInvariants(ctx.prisma);
  });

  it('lets exactly one of two concurrent postings of the same collection commit', async () => {
    const { collectionId } = await legacyDelivery('150');
    const results = await Promise.allSettled([
      postCollection('COD_COLLECTION', collectionId),
      postCollection('PHASE2_BACKFILL', collectionId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('This was already posted');
    expect(
      await ctx.prisma.journalEntry.count({
        where: { sourceType: 'cod_collection', sourceId: collectionId },
      }),
    ).toBe(1);
    expect(await ledgerBalance(ctx.prisma, `DRIVER_CUSTODY:${driver.id}`)).toBe('150.00');
  });

  it('posts each legacy record once when two backfills run at the same time', async () => {
    await legacyDelivery('150');
    await legacyDelivery('80');
    const results = await Promise.allSettled([
      runPhase2Backfill(ctx.prisma, { execute: true }),
      runPhase2Backfill(ctx.prisma, { execute: true }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // 2 collections + 2 fees, regardless of which run posted them.
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'PHASE2_BACKFILL' } })).toBe(4);
    expect(await ledgerBalance(ctx.prisma, `DRIVER_CUSTODY:${driver.id}`)).toBe('230.00');
    expect(await ledgerBalance(ctx.prisma, `MERCHANT_BALANCE:${merchant.id}`)).toBe('-30.00');
    await assertLedgerInvariants(ctx.prisma);
  });
});
