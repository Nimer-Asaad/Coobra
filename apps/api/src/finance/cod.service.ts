import { Injectable } from '@nestjs/common';
import { Prisma, type CodShortfall, type Shipment } from '@coobra/database';
import {
  SHORTFALL_PROPOSER_ROLES,
  type CodCollectionInput,
  type CodConfirmationInput,
  type CodShortfallItem,
  type ProposeShortfallInput,
  type ShortfallStatus,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { ActingContext } from '../common/acting-context.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalService } from './approval.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { accounts, credit, debit, decimal, LedgerService, ZERO } from './ledger.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (value: Prisma.Decimal) => value.toFixed(2);

const shortfallInclude = {
  shipment: {
    select: { id: true, trackingNumber: true, codAmount: true, codCollectedAmount: true },
  },
  merchant: {
    select: { id: true, fullName: true, merchantProfile: { select: { businessName: true } } },
  },
  driver: { select: { id: true, fullName: true } },
  proposedBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.CodShortfallInclude;

type ShortfallRow = Prisma.CodShortfallGetPayload<{ include: typeof shortfallInclude }>;

function toShortfallItem(row: ShortfallRow): CodShortfallItem {
  const collected = row.shipment.codCollectedAmount;
  return {
    id: row.id,
    shipment: { id: row.shipment.id, trackingNumber: row.shipment.trackingNumber },
    merchant: {
      id: row.merchant.id,
      fullName: row.merchant.fullName,
      businessName: row.merchant.merchantProfile?.businessName ?? row.merchant.fullName,
    },
    driver: row.driver,
    expectedAmount: money(row.expectedAmount),
    collectedAmount: money(collected),
    outstandingAmount: money(row.expectedAmount.minus(collected)),
    reason: row.reason,
    status: row.status,
    proposedResolution: row.proposedResolution,
    proposedAmount: row.proposedAmount ? money(row.proposedAmount) : null,
    proposalNote: row.proposalNote,
    proposedBy: row.proposedBy,
    proposedAt: row.proposedAt?.toISOString() ?? null,
    resolution: row.resolution,
    resolvedAmount: row.resolvedAmount ? money(row.resolvedAmount) : null,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    merchantAcceptedAt: row.merchantAcceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    currency: 'ILS',
  };
}

/**
 * Cash on delivery: collections (full, partial and follow-up) with their ledger postings, the
 * delivery-fee posting, and the recipient shortfall workflow (propose → approve, or the
 * merchant's own explicit acceptance). A shortfall is never assigned to anyone automatically.
 */
@Injectable()
export class CodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs inside the DELIVERED transition. Validates the driver's COD confirmation, records the
   * collection, posts COD and the delivery fee, and opens a shortfall for partial payments.
   */
  async onDelivered(
    tx: Tx,
    shipment: Shipment,
    acting: ActingContext,
    cod: CodConfirmationInput,
    now: Date,
  ): Promise<void> {
    // The accountable driver is the principal; the person recorded as acting is the actor.
    const driver = acting.principal;
    const recordedBy = acting.actor;
    const expected = shipment.codAmount;
    const amount = decimal(cod.amount);
    let collected = ZERO;

    if (expected.isZero()) {
      if (cod.collected || !amount.isZero()) throw Errors.shipmentCodMismatch();
    } else {
      if (!cod.collected || amount.isZero()) throw Errors.shipmentCodMismatch();
      if (amount.greaterThan(expected)) throw Errors.codExceedsExpected();
      if (amount.lessThan(expected) && !cod.partialReason) throw Errors.shipmentCodMismatch();
      collected = amount;
    }

    const collection = await tx.codCollection.create({
      data: {
        shipmentId: shipment.id,
        driverId: driver.id,
        collected: cod.collected,
        expectedAmount: expected,
        collectedAmount: amount,
        recordedAt: now,
      },
    });
    if (collected.greaterThan(0)) {
      await this.postCollection(tx, shipment, driver.id, recordedBy.id, collection.id, collected);
    }
    if (shipment.deliveryFee?.greaterThan(0)) {
      await this.ledger.post(tx, {
        kind: 'DELIVERY_FEE',
        sourceType: 'shipment',
        sourceId: shipment.id,
        createdById: recordedBy.id,
        description: `Delivery fee ${shipment.trackingNumber}`,
        lines: [
          debit(accounts.merchantBalance(shipment.merchantId), shipment.deliveryFee, shipment.id),
          credit(accounts.deliveryFeeRevenue(), shipment.deliveryFee, shipment.id),
        ],
      });
    }

    const partial = collected.lessThan(expected);
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        codCollectedAmount: collected,
        codStatus: expected.isZero() ? 'NOT_REQUIRED' : partial ? 'PARTIAL' : 'COLLECTED',
      },
    });
    if (partial) {
      await tx.codShortfall.create({
        data: {
          shipmentId: shipment.id,
          merchantId: shipment.merchantId,
          driverId: driver.id,
          expectedAmount: expected,
          reason: cod.partialReason ?? '',
        },
      });
    }
  }

  private postCollection(
    tx: Tx,
    shipment: Shipment,
    /** The driver whose custody receives the cash (accountable). */
    driverId: string,
    /** The person recorded as having acted (the real actor). */
    createdById: string,
    collectionId: string,
    amount: Prisma.Decimal,
  ) {
    return this.ledger.post(tx, {
      kind: 'COD_COLLECTION',
      sourceType: 'cod_collection',
      sourceId: collectionId,
      createdById,
      description: `COD ${shipment.trackingNumber}`,
      lines: [
        debit(accounts.driverCustody(driverId), amount, shipment.id),
        credit(accounts.merchantPending(shipment.merchantId), amount, shipment.id),
      ],
    });
  }

  /** A later payment on a partially paid shipment, recorded by its driver. */
  collect(
    driver: Actor,
    shipmentId: string,
    input: CodCollectionInput,
    key: string,
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(shipmentId)) throw Errors.notFound();
    return this.idempotency.run(driver.id, `cod-collection:${shipmentId}`, key, input, async () => {
      const result = await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM shipments WHERE id = ${shipmentId}::uuid AND driver_id = ${driver.id}::uuid FOR UPDATE`;
        if (locked.length === 0) throw Errors.notFound();
        const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
        if (shipment.status !== 'DELIVERED' || shipment.codStatus !== 'PARTIAL') {
          throw Errors.invalidState('This shipment has no outstanding cash on delivery');
        }
        const amount = decimal(input.amount);
        const outstanding = shipment.codAmount.minus(shipment.codCollectedAmount);
        if (!amount.greaterThan(0)) throw Errors.validation({ amount: 'validation.money.invalid' });
        if (amount.greaterThan(outstanding)) throw Errors.codExceedsExpected();

        const collection = await tx.codCollection.create({
          data: {
            shipmentId,
            driverId: driver.id,
            collected: true,
            expectedAmount: outstanding,
            collectedAmount: amount,
            idempotencyKey: `${driver.id}:${key}`,
            note: input.note ?? null,
          },
        });
        await this.postCollection(tx, shipment, driver.id, driver.id, collection.id, amount);
        const fullyPaid = amount.equals(outstanding);
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            codCollectedAmount: shipment.codCollectedAmount.plus(amount),
            codStatus: fullyPaid ? 'COLLECTED' : 'PARTIAL',
            version: { increment: 1 },
          },
        });
        const shortfall = await tx.codShortfall.findUnique({ where: { shipmentId } });
        if (shortfall && shortfall.status !== 'RESOLVED') {
          await tx.codShortfall.update({
            where: { id: shortfall.id },
            data: fullyPaid
              ? {
                  status: 'RESOLVED',
                  resolution: 'COLLECTED',
                  resolvedAmount: ZERO,
                  decidedAt: new Date(),
                  version: { increment: 1 },
                }
              : // A pending proposal was for a different amount: it must be proposed again.
                { status: 'OPEN', ...this.clearProposal(), version: { increment: 1 } },
          });
        }
        return {
          collectionId: collection.id,
          collected: money(shipment.codCollectedAmount.plus(amount)),
          outstanding: money(outstanding.minus(amount)),
          codStatus: fullyPaid ? ('COLLECTED' as const) : ('PARTIAL' as const),
        };
      });
      await this.audit.record({
        action: 'COD_COLLECTED',
        actorUserId: driver.id,
        meta,
        metadata: { shipmentId, collectionId: result.collectionId, amount: input.amount },
      });
      return result;
    });
  }

  private clearProposal() {
    return {
      proposedResolution: null,
      proposedAmount: null,
      proposalNote: null,
      proposedById: null,
      proposedAt: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Recipient shortfalls
  // ---------------------------------------------------------------------------

  async listShortfalls(filter: { status?: ShortfallStatus; merchantId?: string }) {
    const rows = await this.prisma.client.codShortfall.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
      },
      include: shortfallInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toShortfallItem);
  }

  private async loadShortfall(tx: Tx, id: string): Promise<CodShortfall> {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM cod_shortfalls WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw Errors.notFound();
    return tx.codShortfall.findUniqueOrThrow({ where: { id } });
  }

  private async outstanding(tx: Tx, shortfall: CodShortfall) {
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shortfall.shipmentId } });
    return shipment.codAmount.minus(shipment.codCollectedAmount);
  }

  private async view(id: string) {
    return toShortfallItem(
      await this.prisma.client.codShortfall.findUniqueOrThrow({
        where: { id },
        include: shortfallInclude,
      }),
    );
  }

  async propose(actor: Actor, id: string, input: ProposeShortfallInput, meta: RequestMeta) {
    if (!(SHORTFALL_PROPOSER_ROLES as readonly UserRole[]).includes(actor.role))
      throw Errors.forbidden();
    const amount = await this.prisma.client.$transaction(async (tx) => {
      const shortfall = await this.loadShortfall(tx, id);
      if (shortfall.status !== 'OPEN')
        throw Errors.invalidState('Only open shortfalls can be proposed');
      const outstanding = await this.outstanding(tx, shortfall);
      await tx.codShortfall.update({
        where: { id },
        data: {
          status:
            input.resolution === 'MERCHANT_ACCEPTS' ? 'AWAITING_MERCHANT' : 'PENDING_APPROVAL',
          proposedResolution: input.resolution,
          proposedAmount: outstanding,
          proposalNote: input.note,
          proposedById: actor.id,
          proposedAt: new Date(),
          version: { increment: 1 },
        },
      });
      return outstanding;
    });
    await this.audit.record({
      action: 'SHORTFALL_PROPOSED',
      actorUserId: actor.id,
      meta,
      metadata: {
        shortfallId: id,
        resolution: input.resolution,
        amount: money(amount),
        note: input.note,
      },
    });
    return this.view(id);
  }

  /** Second person approves a staff proposal; the approved amount is posted to the ledger. */
  approve(actor: Actor, id: string, note: string | undefined, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, `shortfall-approve:${id}`, key, { note }, async () => {
      const resolution = await this.prisma.client.$transaction(async (tx) => {
        const shortfall = await this.loadShortfall(tx, id);
        if (
          shortfall.status !== 'PENDING_APPROVAL' ||
          !shortfall.proposedAmount ||
          !shortfall.proposedById
        ) {
          throw Errors.invalidState('This shortfall has no proposal waiting for approval');
        }
        await this.approvals.assertCanApprove(
          tx,
          actor,
          shortfall.proposedById,
          shortfall.proposedAmount,
        );
        const outstanding = await this.outstanding(tx, shortfall);
        if (!outstanding.equals(shortfall.proposedAmount)) {
          throw Errors.invalidState('The outstanding amount changed since the proposal');
        }
        const amount = shortfall.proposedAmount;
        const debitAccount =
          shortfall.proposedResolution === 'DRIVER_RESPONSIBLE'
            ? accounts.driverReceivable(shortfall.driverId)
            : accounts.codShortfallExpense();
        const entry = await this.ledger.post(tx, {
          kind: 'COD_SHORTFALL',
          sourceType: 'cod_shortfall',
          sourceId: id,
          createdById: actor.id,
          description: `Recipient shortfall ${shortfall.proposedResolution}`,
          lines: [
            debit(debitAccount, amount, shortfall.shipmentId),
            credit(accounts.merchantBalance(shortfall.merchantId), amount, shortfall.shipmentId),
          ],
        });
        await tx.codShortfall.update({
          where: { id },
          data: {
            status: 'RESOLVED',
            resolution: shortfall.proposedResolution,
            resolvedAmount: amount,
            decidedById: actor.id,
            decidedAt: new Date(),
            decisionNote: note ?? null,
            journalEntryId: entry.id,
            version: { increment: 1 },
          },
        });
        await tx.shipment.update({
          where: { id: shortfall.shipmentId },
          data: { codStatus: 'SHORTFALL_RESOLVED' },
        });
        return { resolution: shortfall.proposedResolution, amount: money(amount) };
      });
      await this.audit.record({
        action: 'SHORTFALL_APPROVED',
        actorUserId: actor.id,
        meta,
        metadata: { shortfallId: id, ...resolution },
      });
      return this.view(id);
    });
  }

  async reject(actor: Actor, id: string, note: string, meta: RequestMeta) {
    await this.prisma.client.$transaction(async (tx) => {
      const shortfall = await this.loadShortfall(tx, id);
      if (shortfall.status !== 'PENDING_APPROVAL') {
        throw Errors.invalidState('This shortfall has no proposal waiting for approval');
      }
      await tx.codShortfall.update({
        where: { id },
        data: {
          status: 'OPEN',
          ...this.clearProposal(),
          decisionNote: note,
          version: { increment: 1 },
        },
      });
    });
    await this.audit.record({
      action: 'SHORTFALL_REJECTED',
      actorUserId: actor.id,
      meta,
      metadata: { shortfallId: id, note },
    });
    return this.view(id);
  }

  // Merchant side: only their own cases; acceptance is explicit and never automatic.

  async merchantShortfalls(merchant: Actor) {
    return this.listShortfalls({ merchantId: merchant.id });
  }

  async merchantRespond(
    merchant: Actor,
    id: string,
    accept: boolean,
    note: string | undefined,
    meta: RequestMeta,
  ) {
    await this.prisma.client.$transaction(async (tx) => {
      const shortfall = await this.loadShortfall(tx, id);
      if (shortfall.merchantId !== merchant.id) throw Errors.notFound();
      if (shortfall.status !== 'AWAITING_MERCHANT') {
        throw Errors.invalidState('Nothing is waiting for your answer on this shortfall');
      }
      if (accept) {
        const outstanding = await this.outstanding(tx, shortfall);
        await tx.codShortfall.update({
          where: { id },
          data: {
            status: 'RESOLVED',
            resolution: 'MERCHANT_ACCEPTS',
            resolvedAmount: outstanding,
            decidedById: merchant.id,
            decidedAt: new Date(),
            merchantAcceptedAt: new Date(),
            decisionNote: note ?? null,
            version: { increment: 1 },
          },
        });
        await tx.shipment.update({
          where: { id: shortfall.shipmentId },
          data: { codStatus: 'SHORTFALL_RESOLVED' },
        });
      } else {
        await tx.codShortfall.update({
          where: { id },
          data: {
            status: 'OPEN',
            ...this.clearProposal(),
            decisionNote: note ?? null,
            version: { increment: 1 },
          },
        });
      }
    });
    await this.audit.record({
      action: accept ? 'SHORTFALL_MERCHANT_ACCEPTED' : 'SHORTFALL_MERCHANT_DECLINED',
      actorUserId: merchant.id,
      meta,
      metadata: { shortfallId: id, note: note ?? null },
    });
    return this.view(id);
  }
}
