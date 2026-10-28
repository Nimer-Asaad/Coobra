import request from 'supertest';
import type { Server as App } from 'node:http';
import type { PricingRuleItem, ShipmentDetails, ShipmentReturnInfo } from '@coobra/shared';
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

describe('Return-fee policies (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let ops: TestUser;
  let accountant: TestUser;
  let merchant: TestUser;
  let other: TestUser;
  let driver: TestUser;
  let zones: { ramallah: string; nablus: string };
  const server = () => ctx.app.getHttpServer() as App;
  const api = (user: TestUser) => ({
    get: (path: string) => request(server()).get(path).set('authorization', `Bearer ${user.token}`),
    post: (path: string, body: object = {}) =>
      request(server()).post(path).set('authorization', `Bearer ${user.token}`).send(body),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await createSignedInUser(ctx, 'SUPER_ADMIN', 'admin@example.com');
    ops = await createSignedInUser(ctx, 'OPERATIONS', 'ops@example.com');
    accountant = await createSignedInUser(ctx, 'ACCOUNTANT', 'acc@example.com');
    merchant = await createSignedInUser(ctx, 'MERCHANT', 'm@example.com');
    other = await createSignedInUser(ctx, 'MERCHANT', 'm2@example.com');
    driver = await createSignedInUser(ctx, 'DRIVER', 'd@example.com');
    // Ramallah → Ramallah: fee 15, return fee 10 (RETURN_ONLY); Ramallah → Nablus: fee 25, none.
    zones = await setupBasicPricing(ctx.prisma, [merchant.id, other.id]);
  });

  afterEach(async () => {
    await assertLedgerInvariants(ctx.prisma);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  const move = (user: TestUser, id: string, toStatus: string, reason?: string) => {
    const base =
      user.role === 'DRIVER' ? 'driver' : user.role === 'MERCHANT' ? 'merchant' : 'admin';
    return api(user).post(`/v1/${base}/shipments/${id}/transitions`, {
      toStatus,
      ...(reason ? { reason } : {}),
    });
  };

  const ruleFor = async (destinationZoneId: string, merchantId: string | null = null) =>
    ctx.prisma.pricingRule.findFirstOrThrow({
      where: { active: true, destinationZoneId, merchantId },
    });

  /** Revises the active rule to a policy through the API (a new version). */
  async function setPolicy(destinationZoneId: string, body: object, merchantId?: string) {
    const rule = await ruleFor(destinationZoneId, merchantId ?? null);
    return api(accountant)
      .post(`/v1/admin/pricing-rules/${rule.id}/revise`, {
        deliveryFee: rule.deliveryFee.toFixed(2),
        returnFee: rule.returnFee?.toFixed(2),
        ...body,
      })
      .expect(201);
  }

  async function create(owner = merchant, destinationZoneId = zones.ramallah) {
    const created = await api(owner)
      .post('/v1/merchant/shipments', {
        recipientName: 'Recipient',
        recipientPhone: '0599123456',
        destinationZoneId,
        addressLine: 'Street 1',
        codAmount: '100',
      })
      .expect(201);
    return created.body as ShipmentDetails;
  }

  /** Failed delivery → merchant requests the return → office hand-back (RETURNED). */
  async function failAndReturn(id: string, owner = merchant, returned = true) {
    await api(ops).post(`/v1/admin/shipments/${id}/assign`, { driverId: driver.id }).expect(200);
    await move(driver, id, 'PICKED_UP').expect(200);
    await move(driver, id, 'OUT_FOR_DELIVERY').expect(200);
    await move(driver, id, 'DELIVERY_FAILED', 'Nobody home').expect(200);
    await move(owner, id, 'RETURN_REQUESTED', 'Customer cancelled').expect(200);
    if (returned) await move(ops, id, 'RETURNED').expect(200);
    return (await api(ops).get(`/v1/admin/shipments/${id}`).expect(200)).body as ShipmentDetails;
  }

  const balance = (code: string) => ledgerBalance(ctx.prisma, code);

  it('keeps RETURN_ONLY as the default: only the return fee is charged', async () => {
    const rule = await ruleFor(zones.ramallah);
    expect(rule.returnPolicy).toBe('RETURN_ONLY');
    const shipment = await create();
    expect(shipment.pricing).toMatchObject({ returnPolicy: 'RETURN_ONLY', attemptFee: null });
    const details = await failAndReturn(shipment.id);
    expect(details.returnInfo).toMatchObject({
      feePolicy: 'RETURN_ONLY',
      feeStatus: 'POSTED',
      feeAmount: '10.00',
      deliveryCharge: '0.00',
      totalCharge: '10.00',
    });
    expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-10.00');
    expect(await balance('DELIVERY_FEE_REVENUE')).toBe('0.00');
  });

  it('charges the delivery fee plus the return fee under DELIVERY_PLUS_RETURN', async () => {
    await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const shipment = await create();
    expect(shipment.pricing).toMatchObject({ returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const details = await failAndReturn(shipment.id);
    expect(details.returnInfo).toMatchObject({
      feePolicy: 'DELIVERY_PLUS_RETURN',
      feeStatus: 'POSTED',
      feeAmount: '10.00',
      deliveryCharge: '15.00',
      totalCharge: '25.00',
    });
    expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-25.00');
    expect(await balance('RETURN_FEE_REVENUE')).toBe('10.00');
    expect(await balance('DELIVERY_FEE_REVENUE')).toBe('15.00');
    // One RETURN_FEE entry; the delivery fee is never posted as a separate DELIVERY_FEE.
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'RETURN_FEE' } })).toBe(1);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'DELIVERY_FEE' } })).toBe(0);
    // Posted exactly once: a second attempt to decide the fee is refused.
    await api(accountant)
      .post(`/v1/admin/returns/${shipment.id}/waive`, { reason: 'Too late' })
      .expect(409);
  });

  it('charges the failed-attempt fee plus the return fee under REDUCED_ATTEMPT_PLUS_RETURN', async () => {
    await setPolicy(zones.ramallah, {
      returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
      attemptFee: '5',
    });
    const shipment = await create();
    expect(shipment.pricing).toMatchObject({
      returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
      attemptFee: '5.00',
    });
    const details = await failAndReturn(shipment.id);
    expect(details.returnInfo).toMatchObject({ deliveryCharge: '5.00', totalCharge: '15.00' });
    expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-15.00');
    expect(await balance('DELIVERY_FEE_REVENUE')).toBe('5.00');
    expect(await balance('RETURN_FEE_REVENUE')).toBe('10.00');
  });

  it('lets a merchant-specific rule override the general policy', async () => {
    await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    // The merchant's own rule for the same route keeps RETURN_ONLY.
    await api(accountant)
      .post('/v1/admin/pricing-rules', {
        merchantId: merchant.id,
        originZoneId: zones.ramallah,
        destinationZoneId: zones.ramallah,
        deliveryFee: '14',
        returnFee: '8',
        returnPolicy: 'RETURN_ONLY',
      })
      .expect(201);
    const own = await failAndReturn((await create(merchant)).id);
    expect(own.returnInfo).toMatchObject({ feePolicy: 'RETURN_ONLY', totalCharge: '8.00' });
    const general = await failAndReturn((await create(other)).id, other);
    expect(general.returnInfo).toMatchObject({
      feePolicy: 'DELIVERY_PLUS_RETURN',
      totalCharge: '25.00',
    });
  });

  it('never charges a delivery part without a failed delivery attempt', async () => {
    await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const shipment = await create();
    await api(ops)
      .post(`/v1/admin/shipments/${shipment.id}/assign`, { driverId: driver.id })
      .expect(200);
    await move(driver, shipment.id, 'PICKED_UP').expect(200);
    // Staff call it back before any delivery attempt.
    await move(ops, shipment.id, 'RETURN_REQUESTED', 'Merchant asked to stop').expect(200);
    const details = (await move(ops, shipment.id, 'RETURNED').expect(200)).body as ShipmentDetails;
    expect(details.returnInfo).toMatchObject({ deliveryCharge: '0.00', totalCharge: '10.00' });
    expect(await balance('DELIVERY_FEE_REVENUE')).toBe('0.00');
  });

  it('uses the policy captured when the shipment was priced, not later rule changes', async () => {
    const before = await create(); // priced under RETURN_ONLY
    await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const after = await create(); // priced under DELIVERY_PLUS_RETURN
    await setPolicy(zones.ramallah, { returnPolicy: 'RETURN_ONLY' });
    expect((await failAndReturn(before.id)).returnInfo).toMatchObject({ totalCharge: '10.00' });
    expect((await failAndReturn(after.id)).returnInfo).toMatchObject({ totalCharge: '25.00' });
    // Rules are versioned: three versions of the same rule group exist, one active.
    const versions = await ctx.prisma.pricingRule.findMany({
      where: { ruleGroupId: (await ruleFor(zones.ramallah)).ruleGroupId },
    });
    expect(versions.map((rule) => rule.returnPolicy).sort()).toEqual([
      'DELIVERY_PLUS_RETURN',
      'RETURN_ONLY',
      'RETURN_ONLY',
    ]);
  });

  it('waives the whole return charge, including the delivery part', async () => {
    await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const shipment = await create();
    await failAndReturn(shipment.id, merchant, false);
    const waived = (
      await api(accountant)
        .post(`/v1/admin/returns/${shipment.id}/waive`, { reason: 'Our driver was late' })
        .expect(200)
    ).body as ShipmentReturnInfo;
    expect(waived).toMatchObject({
      feeStatus: 'WAIVED',
      deliveryCharge: '15.00',
      totalCharge: '0.00',
    });
    await move(ops, shipment.id, 'RETURNED').expect(200);
    expect(await ctx.prisma.journalEntry.count()).toBe(0);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'RETURN_FEE_WAIVED' },
    });
    expect(audit.metadata).toMatchObject({
      feePolicy: 'DELIVERY_PLUS_RETURN',
      waivedDeliveryCharge: '15.00',
    });
  });

  it('posts the delivery part with an explicitly set fee when none was configured', async () => {
    // Ramallah → Nablus has no return fee configured.
    await setPolicy(zones.nablus, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
    const shipment = await create(merchant, zones.nablus);
    const details = await failAndReturn(shipment.id);
    expect(details.returnInfo).toMatchObject({
      feeStatus: 'RETURN_FEE_UNCONFIGURED',
      deliveryCharge: '25.00',
      totalCharge: null,
    });
    // Nothing is charged until finance decides the return fee.
    expect(await ctx.prisma.journalEntry.count()).toBe(0);
    const info = (
      await api(accountant)
        .post(`/v1/admin/returns/${shipment.id}/fee`, { amount: '0', reason: 'No return fee' })
        .expect(200)
    ).body as ShipmentReturnInfo;
    expect(info).toMatchObject({ feeStatus: 'POSTED', totalCharge: '25.00' });
    expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-25.00');
    expect(await balance('RETURN_FEE_REVENUE')).toBe('0.00');
    await api(accountant)
      .post(`/v1/admin/returns/${shipment.id}/fee`, { amount: '3', reason: 'Again' })
      .expect(409);
    expect(await ctx.prisma.journalEntry.count({ where: { kind: 'RETURN_FEE' } })).toBe(1);
  });

  it('validates and audits policy configuration; only pricing managers may change it', async () => {
    const base = {
      originZoneId: zones.nablus,
      destinationZoneId: zones.ramallah,
      deliveryFee: '20',
      returnFee: '6',
    };
    const fieldError = async (user: TestUser, body: object) =>
      (await api(user).post('/v1/admin/pricing-rules', body).expect(400)).body.fieldErrors;
    expect(
      await fieldError(accountant, { ...base, returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN' }),
    ).toMatchObject({ attemptFee: 'validation.pricing.attemptFeeRequired' });
    expect(
      await fieldError(accountant, {
        ...base,
        returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
        attemptFee: '21',
      }),
    ).toMatchObject({ attemptFee: 'validation.pricing.attemptFeeTooHigh' });
    expect(await fieldError(accountant, { ...base, attemptFee: '5' })).toMatchObject({
      attemptFee: 'validation.pricing.attemptFeeNotAllowed',
    });
    expect(await fieldError(accountant, { ...base, returnPolicy: 'FREE' })).toMatchObject({
      returnPolicy: 'validation.pricing.returnPolicy',
    });

    const body = { ...base, returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN', attemptFee: '7' };
    await api(merchant).post('/v1/admin/pricing-rules', body).expect(403);
    await api(ops).post('/v1/admin/pricing-rules', body).expect(403);
    const created = (await api(admin).post('/v1/admin/pricing-rules', body).expect(201))
      .body as PricingRuleItem;
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRICING_RULE_CREATED' },
    });
    expect(audit.metadata).toMatchObject({
      returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
      attemptFee: '7.00',
    });

    // Revising without a policy keeps it; the attempt fee may not exceed the new delivery fee.
    const kept = await api(accountant)
      .post(`/v1/admin/pricing-rules/${created.id}/revise`, { deliveryFee: '18', returnFee: '6' })
      .expect(201);
    const keptRow = await ctx.prisma.pricingRule.findUniqueOrThrow({ where: { id: kept.body.id } });
    expect(keptRow.returnPolicy).toBe('REDUCED_ATTEMPT_PLUS_RETURN');
    expect(keptRow.attemptFee?.toFixed(2)).toBe('7.00');
    expect(
      (
        await api(accountant)
          .post(`/v1/admin/pricing-rules/${kept.body.id}/revise`, { deliveryFee: '5' })
          .expect(400)
      ).body.fieldErrors,
    ).toMatchObject({ attemptFee: 'validation.pricing.attemptFeeTooHigh' });
    const listed = (await api(accountant).get('/v1/admin/pricing-rules').expect(200))
      .body as PricingRuleItem[];
    expect(listed.find((rule) => rule.id === kept.body.id)).toMatchObject({
      returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
      attemptFee: '7.00',
    });
    const revised = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRICING_RULE_REVISED' },
    });
    expect(revised.metadata).toMatchObject({ returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN' });
  });

  describe('approved rules (ADR 0002)', () => {
    const reduced = { returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN', attemptFee: '5' };
    const entries = (kind: 'RETURN_FEE' | 'DELIVERY_FEE') =>
      ctx.prisma.journalEntry.count({ where: { kind } });

    it('rule 1: no attempt fee unless a delivery attempt actually failed', async () => {
      await setPolicy(zones.ramallah, reduced);
      const shipment = await create();
      await api(ops)
        .post(`/v1/admin/shipments/${shipment.id}/assign`, { driverId: driver.id })
        .expect(200);
      await move(driver, shipment.id, 'PICKED_UP').expect(200);
      await move(ops, shipment.id, 'RETURN_REQUESTED', 'Merchant asked to stop').expect(200);
      const details = (await move(ops, shipment.id, 'RETURNED').expect(200))
        .body as ShipmentDetails;
      expect(details.returnInfo).toMatchObject({
        feePolicy: 'REDUCED_ATTEMPT_PLUS_RETURN',
        deliveryCharge: '0.00',
        totalCharge: '10.00',
      });
      expect(await balance('DELIVERY_FEE_REVENUE')).toBe('0.00');
      expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-10.00');
    });

    it('rule 2: one attempt fee per shipment, however many attempts failed', async () => {
      await setPolicy(zones.ramallah, reduced);
      const shipment = await create();
      await api(ops)
        .post(`/v1/admin/shipments/${shipment.id}/assign`, { driverId: driver.id })
        .expect(200);
      await move(driver, shipment.id, 'PICKED_UP').expect(200);
      for (let attempt = 0; attempt < 3; attempt++) {
        await move(driver, shipment.id, 'OUT_FOR_DELIVERY').expect(200);
        await move(driver, shipment.id, 'DELIVERY_FAILED', `Attempt ${attempt + 1}`).expect(200);
      }
      await move(merchant, shipment.id, 'RETURN_REQUESTED', 'Give up').expect(200);
      const details = (await move(ops, shipment.id, 'RETURNED').expect(200))
        .body as ShipmentDetails;
      expect(
        await ctx.prisma.shipmentStatusHistory.count({
          where: { shipmentId: shipment.id, toStatus: 'DELIVERY_FAILED' },
        }),
      ).toBe(3);
      expect(details.returnInfo).toMatchObject({ deliveryCharge: '5.00', totalCharge: '15.00' });
      expect(await balance('DELIVERY_FEE_REVENUE')).toBe('5.00');
      expect(await entries('RETURN_FEE')).toBe(1);
      expect(await entries('DELIVERY_FEE')).toBe(0);
    });

    it('rule 3: a waiver removes every return-related charge', async () => {
      for (const policy of [{ returnPolicy: 'DELIVERY_PLUS_RETURN' }, reduced]) {
        await setPolicy(zones.ramallah, policy);
        const shipment = await create();
        await failAndReturn(shipment.id, merchant, false);
        await api(accountant)
          .post(`/v1/admin/returns/${shipment.id}/waive`, { reason: 'Our mistake' })
          .expect(200);
        const details = (await move(ops, shipment.id, 'RETURNED').expect(200))
          .body as ShipmentDetails;
        expect(details.returnInfo).toMatchObject({ feeStatus: 'WAIVED', totalCharge: '0.00' });
        // A waived return can never be charged later.
        await api(accountant)
          .post(`/v1/admin/returns/${shipment.id}/fee`, { amount: '10', reason: 'Charge it' })
          .expect(409);
      }
      expect(await ctx.prisma.journalEntry.count()).toBe(0);
      expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('0.00');
    });

    it('never posts a return charge twice, even when posting is retried directly', async () => {
      await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
      const shipment = await create();
      await failAndReturn(shipment.id);
      const entry = await ctx.prisma.journalEntry.findFirstOrThrow({
        where: { kind: 'RETURN_FEE' },
      });
      // The database refuses a second entry for the same return record.
      await expect(
        ctx.prisma.journalEntry.create({
          data: { kind: 'RETURN_FEE', sourceType: entry.sourceType, sourceId: entry.sourceId },
        }),
      ).rejects.toThrow();
      // Repeating the office hand-back is refused; still one charge of 25.
      await move(ops, shipment.id, 'RETURNED').expect(409);
      expect(await entries('RETURN_FEE')).toBe(1);
      expect(await balance(`MERCHANT_BALANCE:${merchant.id}`)).toBe('-25.00');
    });

    it('keeps old snapshots and posted entries when the policy changes later', async () => {
      const old = await create(); // RETURN_ONLY snapshot
      await failAndReturn(old.id);
      const posted = await ctx.prisma.journalEntry.findMany({ include: { lines: true } });
      await setPolicy(zones.ramallah, { returnPolicy: 'DELIVERY_PLUS_RETURN' });
      const snapshot = await ctx.prisma.shipmentPricing.findUniqueOrThrow({
        where: { shipmentId: old.id },
      });
      expect(snapshot.returnPolicy).toBe('RETURN_ONLY');
      expect(await ctx.prisma.journalEntry.findMany({ include: { lines: true } })).toEqual(posted);
    });
  });

  it('refuses inconsistent policy rows at the database level', async () => {
    const rule = await ruleFor(zones.ramallah);
    await expect(
      ctx.prisma.pricingRule.update({
        where: { id: rule.id },
        data: { returnPolicy: 'REDUCED_ATTEMPT_PLUS_RETURN' },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.pricingRule.update({ where: { id: rule.id }, data: { attemptFee: '5' } }),
    ).rejects.toThrow();
  });
});
