import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PricingRule, type ReturnFeePolicy } from '@coobra/database';
import {
  QUOTE_TTL_MINUTES,
  type CreatePricingRuleInput,
  type PricingQuote,
  type PricingRuleItem,
  type PricingSource,
  type RevisePricingRuleInput,
  type ShipmentStatus,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { assertNoImpersonationConflict } from '../impersonation/write-guards.js';
import { Errors } from '../common/app-exception.js';
import type { ActingContext } from '../common/acting-context.js';
import { assertImpersonationActiveIn } from '../impersonation/write-guards.js';
import { CLOCK, systemClock, type Clock } from '../common/clock.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneLabel, ZonesService, type ZonePath } from './zones.service.js';

type Db = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses in which the delivery fee can still be changed directly (not yet posted). */
const PRE_DELIVERY_STATUSES: readonly ShipmentStatus[] = [
  'CREATED',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
];

export interface PriceResult {
  rule: PricingRule;
  source: PricingSource;
  merchantSpecific: boolean;
  origin: ZonePath;
  destination: ZonePath;
  fee: Prisma.Decimal;
  returnFee: Prisma.Decimal | null;
  returnPolicy: ReturnFeePolicy;
  attemptFee: Prisma.Decimal | null;
}

const money = (value: Prisma.Decimal) => value.toFixed(2);

/**
 * Hybrid route pricing. Precedence: merchant route → general route → merchant fallback →
 * general fallback; otherwise PRICING_UNAVAILABLE (a price is never invented). A route rule
 * matches when its zones are the shipment's zones or their ancestors; ties go to the deeper
 * destination, then deeper origin, higher priority, later effective date, then id.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zones: ZonesService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock = systemClock,
  ) {}

  async price(
    db: Db,
    input: { merchantId: string; originZoneId: string; destinationZoneId: string; at?: Date },
  ): Promise<PriceResult> {
    const at = input.at ?? new Date();
    const origin = await this.zones.activePath(db, input.originZoneId);
    const destination = await this.zones.activePath(db, input.destinationZoneId);
    const originDepth = new Map(origin.map((zone) => [zone.id, zone.depth]));
    const destinationDepth = new Map(destination.map((zone) => [zone.id, zone.depth]));

    const candidates = await db.pricingRule.findMany({
      where: {
        active: true,
        effectiveFrom: { lte: at },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
          { OR: [{ merchantId: input.merchantId }, { merchantId: null }] },
          {
            OR: [
              { isFallback: true },
              {
                originZoneId: { in: [...originDepth.keys()] },
                destinationZoneId: { in: [...destinationDepth.keys()] },
              },
            ],
          },
        ],
      },
    });

    const tier = (rule: PricingRule) =>
      rule.merchantId ? (rule.isFallback ? 3 : 1) : rule.isFallback ? 4 : 2;
    const ranked = candidates.sort(
      (a, b) =>
        tier(a) - tier(b) ||
        (destinationDepth.get(b.destinationZoneId ?? '') ?? -1) -
          (destinationDepth.get(a.destinationZoneId ?? '') ?? -1) ||
        (originDepth.get(b.originZoneId ?? '') ?? -1) -
          (originDepth.get(a.originZoneId ?? '') ?? -1) ||
        b.priority - a.priority ||
        b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
        (a.id < b.id ? 1 : -1),
    );
    const rule = ranked[0];
    if (!rule) throw Errors.pricingUnavailable();

    const sources: Record<number, PricingSource> = {
      1: 'MERCHANT_ROUTE',
      2: 'GENERAL_ROUTE',
      3: 'MERCHANT_FALLBACK',
      4: 'GENERAL_FALLBACK',
    };
    return {
      rule,
      source: sources[tier(rule)] ?? 'GENERAL_FALLBACK',
      merchantSpecific: rule.merchantId !== null,
      origin,
      destination,
      fee: rule.deliveryFee,
      returnFee: rule.returnFee,
      returnPolicy: rule.returnPolicy,
      attemptFee: rule.attemptFee,
    };
  }

  /** The merchant's approved pickup zone unless staff give an origin. */
  async resolveOrigin(db: Db, merchantId: string, originZoneId: string | undefined) {
    if (originZoneId) return originZoneId;
    const profile = await db.merchantProfile.findUnique({ where: { userId: merchantId } });
    if (!profile?.defaultPickupZoneId) throw Errors.originZoneRequired();
    return profile.defaultPickupZoneId;
  }

  private toQuote(
    result: PriceResult,
    quote: { id: string; createdAt: Date; expiresAt: Date } | null,
  ): PricingQuote {
    return {
      quoteId: quote?.id ?? null,
      origin: zoneLabel(result.origin),
      destination: zoneLabel(result.destination),
      ruleId: result.rule.id,
      ruleVersion: result.rule.version,
      source: result.source,
      merchantSpecific: result.merchantSpecific,
      baseFee: money(result.fee),
      finalFee: money(result.fee),
      returnFee: result.returnFee ? money(result.returnFee) : null,
      returnPolicy: result.returnPolicy,
      attemptFee: result.attemptFee ? money(result.attemptFee) : null,
      currency: 'ILS',
      quotedAt: (quote?.createdAt ?? new Date()).toISOString(),
      expiresAt: quote?.expiresAt.toISOString() ?? null,
    };
  }

  /** Staff preview: priced but not persisted (staff shipments are re-priced on creation). */
  async preview(input: { merchantId: string; originZoneId?: string; destinationZoneId: string }) {
    const db = this.prisma.client;
    const originZoneId = await this.resolveOrigin(db, input.merchantId, input.originZoneId);
    const result = await this.price(db, { ...input, originZoneId });
    return this.toQuote(result, null);
  }

  /** Merchant quote: persisted, single-use and valid for QUOTE_TTL_MINUTES. */
  async quoteForMerchant(
    acting: ActingContext,
    input: { destinationZoneId: string },
  ): Promise<PricingQuote> {
    // The quote is the principal's; the real actor is recorded as having requested it.
    const merchant = acting.principal;
    return this.prisma.client.$transaction(async (db) => {
      // During an impersonation the write re-validates it inside its own transaction.
      await assertImpersonationActiveIn(db, acting, () => this.clock.now());
      // Always the approved pickup zone: a merchant cannot choose the origin of their price.
      const originZoneId = await this.resolveOrigin(db, merchant.id, undefined);
      const result = await this.price(db, {
        merchantId: merchant.id,
        originZoneId,
        destinationZoneId: input.destinationZoneId,
      });
      const quote = await db.pricingQuote.create({
        data: {
          merchantId: merchant.id,
          originZoneId,
          destinationZoneId: input.destinationZoneId,
          ruleId: result.rule.id,
          ruleVersion: result.rule.version,
          source: result.source,
          deliveryFee: result.fee,
          returnFee: result.returnFee,
          createdById: acting.actor.id,
          ...(acting.impersonation ? { impersonationId: acting.impersonation.id } : {}),
          expiresAt: new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000),
        },
      });
      return this.toQuote(result, quote);
    });
  }

  /**
   * Checks a quote without claiming it (the impersonation fee preview): the same conditions as
   * consumeQuote, and the current price.
   */
  async inspectQuote(
    db: Db,
    input: {
      quoteId: string;
      merchantId: string;
      originZoneId: string;
      destinationZoneId: string;
      impersonationId: string | null;
    },
  ): Promise<PriceResult & { quoteId: string }> {
    const now = new Date();
    const quote = await db.pricingQuote.findFirst({
      where: {
        id: input.quoteId,
        merchantId: input.merchantId,
        originZoneId: input.originZoneId,
        destinationZoneId: input.destinationZoneId,
        impersonationId: input.impersonationId,
        usedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!quote) throw Errors.quoteInvalid();
    const current = await this.price(db, { ...input, at: now });
    if (
      current.rule.id !== quote.ruleId ||
      current.rule.version !== quote.ruleVersion ||
      !current.fee.equals(quote.deliveryFee)
    ) {
      throw Errors.priceChanged();
    }
    return { ...current, quoteId: quote.id };
  }

  /**
   * Claims a quote inside the shipment-creation transaction. The quote must belong to the
   * merchant, match the route, be unused and unexpired, and still equal the current price.
   */
  async consumeQuote(
    db: Db,
    input: {
      quoteId: string;
      merchantId: string;
      originZoneId: string;
      destinationZoneId: string;
      /**
       * ADR 0003 decision 3: a quote is usable only in the context that created it. An
       * impersonation uses only its own quotes; the merchant's own session only quotes made
       * outside an impersonation.
       */
      impersonationId?: string | null;
    },
  ): Promise<PriceResult & { quoteId: string }> {
    const now = new Date();
    const claimed = await db.pricingQuote.updateMany({
      where: {
        id: input.quoteId,
        merchantId: input.merchantId,
        originZoneId: input.originZoneId,
        destinationZoneId: input.destinationZoneId,
        impersonationId: input.impersonationId ?? null,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw Errors.quoteInvalid();
    const quote = await db.pricingQuote.findUniqueOrThrow({ where: { id: input.quoteId } });
    const current = await this.price(db, {
      merchantId: input.merchantId,
      originZoneId: input.originZoneId,
      destinationZoneId: input.destinationZoneId,
      at: now,
    });
    if (
      current.rule.id !== quote.ruleId ||
      current.rule.version !== quote.ruleVersion ||
      !current.fee.equals(quote.deliveryFee)
    ) {
      throw Errors.priceChanged();
    }
    return { ...current, quoteId: quote.id };
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  async listRules(filter: { merchantId?: string; includeInactive?: boolean }) {
    const rules = await this.prisma.client.pricingRule.findMany({
      where: {
        ...(filter.includeInactive ? {} : { active: true }),
        ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
      },
      include: { merchant: { include: { merchantProfile: true } } },
      orderBy: [{ isFallback: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const labels = await this.zones.labels(
      this.prisma.client,
      rules
        .flatMap((rule) => [rule.originZoneId, rule.destinationZoneId])
        .filter((id): id is string => !!id),
    );
    return rules.map(
      (rule): PricingRuleItem => ({
        id: rule.id,
        ruleGroupId: rule.ruleGroupId,
        version: rule.version,
        merchant: rule.merchant
          ? {
              id: rule.merchant.id,
              businessName: rule.merchant.merchantProfile?.businessName ?? rule.merchant.fullName,
            }
          : null,
        originZone: rule.originZoneId ? (labels.get(rule.originZoneId) ?? null) : null,
        destinationZone: rule.destinationZoneId
          ? (labels.get(rule.destinationZoneId) ?? null)
          : null,
        isFallback: rule.isFallback,
        deliveryFee: money(rule.deliveryFee),
        returnFee: rule.returnFee ? money(rule.returnFee) : null,
        returnPolicy: rule.returnPolicy,
        attemptFee: rule.attemptFee ? money(rule.attemptFee) : null,
        currency: 'ILS',
        priority: rule.priority,
        effectiveFrom: rule.effectiveFrom.toISOString(),
        effectiveTo: rule.effectiveTo?.toISOString() ?? null,
        active: rule.active,
        note: rule.note,
        createdAt: rule.createdAt.toISOString(),
      }),
    );
  }

  async createRule(actor: Actor, input: CreatePricingRuleInput, meta: RequestMeta) {
    const db = this.prisma.client;
    if (input.merchantId) {
      const merchant = await db.user.findFirst({
        where: { id: input.merchantId, role: 'MERCHANT' },
      });
      if (!merchant) throw Errors.shipmentMerchantInvalid();
    }
    for (const zoneId of [input.originZoneId, input.destinationZoneId]) {
      if (zoneId) await this.zones.path(db, zoneId);
    }
    const rule = await db.pricingRule.create({
      data: {
        ruleGroupId: randomUUID(),
        version: 1,
        merchantId: input.merchantId ?? null,
        originZoneId: input.originZoneId ?? null,
        destinationZoneId: input.destinationZoneId ?? null,
        isFallback: input.isFallback,
        deliveryFee: input.deliveryFee,
        returnFee: input.returnFee ?? null,
        returnPolicy: input.returnPolicy,
        attemptFee: input.attemptFee ?? null,
        priority: input.priority,
        ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        note: input.note ?? null,
        createdById: actor.id,
      },
    });
    await this.audit.record({
      action: 'PRICING_RULE_CREATED',
      actorUserId: actor.id,
      targetUserId: rule.merchantId,
      meta,
      metadata: {
        ruleId: rule.id,
        deliveryFee: money(rule.deliveryFee),
        returnFee: rule.returnFee ? money(rule.returnFee) : null,
        returnPolicy: rule.returnPolicy,
        attemptFee: rule.attemptFee ? money(rule.attemptFee) : null,
        isFallback: rule.isFallback,
      },
    });
    return rule;
  }

  /** Creates the next version of a rule and deactivates the current one (atomically). */
  async reviseRule(actor: Actor, id: string, input: RevisePricingRuleInput, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const now = new Date();
    const next = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.pricingRule.findUnique({ where: { id } });
      if (!current) throw Errors.notFound();
      const retired = await tx.pricingRule.updateMany({
        where: { id, active: true },
        data: { active: false, supersededAt: now },
      });
      if (retired.count !== 1)
        throw Errors.conflict('Only the active version of a rule can be revised');
      // Without a new policy the current one (and its attempt fee) is kept, never reset.
      const returnPolicy = input.returnPolicy ?? current.returnPolicy;
      const attemptFee = input.returnPolicy
        ? input.attemptFee
          ? new Prisma.Decimal(input.attemptFee)
          : null
        : current.attemptFee;
      if (attemptFee?.greaterThan(input.deliveryFee)) {
        throw Errors.validation({ attemptFee: 'validation.pricing.attemptFeeTooHigh' });
      }
      return tx.pricingRule.create({
        data: {
          ruleGroupId: current.ruleGroupId,
          version: current.version + 1,
          merchantId: current.merchantId,
          originZoneId: current.originZoneId,
          destinationZoneId: current.destinationZoneId,
          isFallback: current.isFallback,
          deliveryFee: input.deliveryFee,
          returnFee: input.returnFee ?? null,
          returnPolicy,
          attemptFee,
          priority: input.priority,
          effectiveFrom: now,
          effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
          note: input.note ?? current.note,
          createdById: actor.id,
        },
      });
    });
    await this.audit.record({
      action: 'PRICING_RULE_REVISED',
      actorUserId: actor.id,
      targetUserId: next.merchantId,
      meta,
      metadata: {
        previousRuleId: id,
        ruleId: next.id,
        version: next.version,
        deliveryFee: money(next.deliveryFee),
        returnFee: next.returnFee ? money(next.returnFee) : null,
        returnPolicy: next.returnPolicy,
        attemptFee: next.attemptFee ? money(next.attemptFee) : null,
      },
    });
    return next;
  }

  async deactivateRule(actor: Actor, id: string, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const result = await this.prisma.client.pricingRule.updateMany({
      where: { id, active: true },
      data: { active: false, supersededAt: new Date() },
    });
    if (result.count !== 1) throw Errors.notFound();
    await this.audit.record({
      action: 'PRICING_RULE_DEACTIVATED',
      actorUserId: actor.id,
      meta,
      metadata: { ruleId: id },
    });
  }

  // ---------------------------------------------------------------------------
  // Pickup zones and fee overrides
  // ---------------------------------------------------------------------------

  async setPickupZone(actor: Actor, merchantId: string, zoneId: string, meta: RequestMeta) {
    const db = this.prisma.client;
    await this.zones.activePath(db, zoneId);
    const updated = await db.merchantProfile.updateMany({
      where: { userId: merchantId },
      data: { defaultPickupZoneId: zoneId },
    });
    if (updated.count !== 1) throw Errors.shipmentMerchantInvalid();
    await this.audit.record({
      action: 'MERCHANT_PICKUP_ZONE_SET',
      actorUserId: actor.id,
      targetUserId: merchantId,
      meta,
      metadata: { zoneId },
    });
  }

  /**
   * Changes the delivery fee of a shipment that has not been delivered yet (the fee is only
   * posted to the ledger on delivery). Atomic with the shipment's version; always recorded.
   */
  async overrideBeforeDelivery(
    actor: Actor,
    shipmentId: string,
    input: { fee: string; reason: string },
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(shipmentId)) throw Errors.notFound();
    const override = await this.prisma.client.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
      // R1 (ADR 0003 §10.2): never override the fee of a shipment you were involved in.
      if (shipment) await assertNoImpersonationConflict(tx, shipmentId, actor.id);
      if (!shipment) throw Errors.notFound();
      if (!PRE_DELIVERY_STATUSES.includes(shipment.status)) throw Errors.feeOverrideNotAllowed();
      const updated = await tx.shipment.updateMany({
        where: { id: shipmentId, version: shipment.version, status: shipment.status },
        data: { deliveryFee: input.fee, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw Errors.shipmentConcurrentUpdate();
      return tx.shipmentFeeOverride.create({
        data: {
          shipmentId,
          phase: 'PRE_DELIVERY',
          status: 'APPLIED',
          previousFee: shipment.deliveryFee,
          newFee: input.fee,
          reason: input.reason,
          actorId: actor.id,
          actorRole: actor.role,
        },
      });
    });
    await this.audit.record({
      action: 'SHIPMENT_FEE_OVERRIDDEN',
      actorUserId: actor.id,
      meta,
      metadata: {
        shipmentId,
        overrideId: override.id,
        previousFee: override.previousFee ? money(override.previousFee) : null,
        newFee: money(override.newFee),
        reason: input.reason,
      },
    });
    return override;
  }
}
