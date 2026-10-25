import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import type { AdjustmentInput, AdjustmentItem, FeeCorrectionInput, UserRole } from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalService } from './approval.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { accounts, credit, debit, decimal, LedgerService } from './ledger.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (value: Prisma.Decimal) => value.toFixed(2);

const adjustmentInclude = {
  merchant: {
    select: { id: true, fullName: true, merchantProfile: { select: { businessName: true } } },
  },
  requestedBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.FinancialAdjustmentInclude;

/**
 * Corrections after money was posted. Nothing posted is edited: a fee correction reverses the
 * current fee entry and posts the corrected fee; a merchant adjustment posts a new entry. Both
 * need a second person to approve (and a SUPER_ADMIN above the threshold).
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Post-delivery fee corrections (recorded as POST_DELIVERY fee overrides)
  // ---------------------------------------------------------------------------

  async requestFeeCorrection(
    actor: Actor,
    shipmentId: string,
    input: FeeCorrectionInput,
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(shipmentId)) throw Errors.notFound();
    const override = await this.prisma.client.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
      if (!shipment) throw Errors.notFound();
      if (shipment.status !== 'DELIVERED') {
        throw Errors.invalidState(
          'Fee corrections apply to delivered shipments; change the fee directly before delivery',
        );
      }
      const pending = await tx.shipmentFeeOverride.count({
        where: { shipmentId, phase: 'POST_DELIVERY', status: 'PENDING_APPROVAL' },
      });
      if (pending > 0)
        throw Errors.invalidState('A fee correction is already waiting for approval');
      if (shipment.deliveryFee && decimal(input.fee).equals(shipment.deliveryFee)) {
        throw Errors.validation({ fee: 'validation.finance.sameFee' });
      }
      return tx.shipmentFeeOverride.create({
        data: {
          shipmentId,
          phase: 'POST_DELIVERY',
          status: 'PENDING_APPROVAL',
          previousFee: shipment.deliveryFee,
          newFee: input.fee,
          reason: input.reason,
          actorId: actor.id,
          actorRole: actor.role,
        },
      });
    });
    await this.audit.record({
      action: 'FEE_CORRECTION_REQUESTED',
      actorUserId: actor.id,
      meta,
      metadata: { shipmentId, overrideId: override.id, newFee: input.fee, reason: input.reason },
    });
    return { id: override.id };
  }

  /** The non-reversed fee posting currently charged for a shipment, if any. */
  private async currentFeeEntry(tx: Tx, shipmentId: string) {
    return tx.journalEntry.findFirst({
      where: {
        kind: { in: ['DELIVERY_FEE', 'FEE_ADJUSTMENT'] },
        lines: { some: { shipmentId } },
        reversedBy: { is: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  decideFeeCorrection(
    actor: Actor,
    overrideId: string,
    approve: boolean,
    note: string | undefined,
    key: string,
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(overrideId)) throw Errors.notFound();
    return this.idempotency.run(
      actor.id,
      `fee-correction:${overrideId}`,
      key,
      { approve, note },
      async () => {
        const result = await this.prisma.client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM shipment_fee_overrides WHERE id = ${overrideId}::uuid FOR UPDATE`;
          if (locked.length === 0) throw Errors.notFound();
          const override = await tx.shipmentFeeOverride.findUniqueOrThrow({
            where: { id: overrideId },
          });
          if (override.phase !== 'POST_DELIVERY' || override.status !== 'PENDING_APPROVAL') {
            throw Errors.invalidState('This fee correction is not waiting for approval');
          }
          const previous = override.previousFee ?? decimal(0);
          await this.approvals.assertCanApprove(
            tx,
            actor,
            override.actorId,
            override.newFee.minus(previous).abs(),
          );
          if (!approve) {
            await tx.shipmentFeeOverride.update({
              where: { id: overrideId },
              data: {
                status: 'REJECTED',
                approvedById: actor.id,
                decidedAt: new Date(),
                decisionNote: note ?? null,
              },
            });
            return { approved: false, shipmentId: override.shipmentId };
          }
          const shipment = await tx.shipment.findUniqueOrThrow({
            where: { id: override.shipmentId },
          });
          const current = await this.currentFeeEntry(tx, shipment.id);
          if (current) {
            await this.ledger.reverse(tx, current.id, {
              createdById: actor.id,
              description: `Fee correction ${shipment.trackingNumber}: ${override.reason}`,
            });
          }
          if (override.newFee.greaterThan(0)) {
            await this.ledger.post(tx, {
              kind: 'FEE_ADJUSTMENT',
              sourceType: 'fee_override',
              sourceId: override.id,
              createdById: actor.id,
              description: `Corrected delivery fee ${shipment.trackingNumber}`,
              lines: [
                debit(accounts.merchantBalance(shipment.merchantId), override.newFee, shipment.id),
                credit(accounts.deliveryFeeRevenue(), override.newFee, shipment.id),
              ],
            });
          }
          await tx.shipment.update({
            where: { id: shipment.id },
            data: { deliveryFee: override.newFee, version: { increment: 1 } },
          });
          await tx.shipmentFeeOverride.update({
            where: { id: overrideId },
            data: {
              status: 'APPLIED',
              approvedById: actor.id,
              decidedAt: new Date(),
              decisionNote: note ?? null,
            },
          });
          return { approved: true, shipmentId: shipment.id, newFee: money(override.newFee) };
        });
        await this.audit.record({
          action: approve ? 'FEE_CORRECTION_APPROVED' : 'FEE_CORRECTION_REJECTED',
          actorUserId: actor.id,
          meta,
          metadata: { overrideId, ...result, note: note ?? null },
        });
        return result;
      },
    );
  }

  async pendingFeeCorrections() {
    const rows = await this.prisma.client.shipmentFeeOverride.findMany({
      where: { phase: 'POST_DELIVERY', status: 'PENDING_APPROVAL' },
      include: {
        shipment: { select: { id: true, trackingNumber: true } },
        actor: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      shipment: row.shipment,
      previousFee: row.previousFee ? money(row.previousFee) : null,
      newFee: money(row.newFee),
      reason: row.reason,
      requestedBy: row.actor,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // Merchant credit / debit adjustments
  // ---------------------------------------------------------------------------

  private toItem(
    row: Prisma.FinancialAdjustmentGetPayload<{ include: typeof adjustmentInclude }>,
  ): AdjustmentItem {
    return {
      id: row.id,
      type: row.type,
      merchant: {
        id: row.merchant.id,
        fullName: row.merchant.fullName,
        businessName: row.merchant.merchantProfile?.businessName ?? row.merchant.fullName,
      },
      amount: money(row.amount),
      reason: row.reason,
      status: row.status,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listAdjustments() {
    const rows = await this.prisma.client.financialAdjustment.findMany({
      include: adjustmentInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => this.toItem(row));
  }

  async requestAdjustment(actor: Actor, input: AdjustmentInput, meta: RequestMeta) {
    const merchant = await this.prisma.client.user.findFirst({
      where: { id: input.merchantId, role: 'MERCHANT' },
    });
    if (!merchant) throw Errors.shipmentMerchantInvalid();
    const row = await this.prisma.client.financialAdjustment.create({
      data: { ...input, requestedById: actor.id },
      include: adjustmentInclude,
    });
    await this.audit.record({
      action: 'ADJUSTMENT_REQUESTED',
      actorUserId: actor.id,
      targetUserId: input.merchantId,
      meta,
      metadata: {
        adjustmentId: row.id,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
      },
    });
    return this.toItem(row);
  }

  decideAdjustment(
    actor: Actor,
    id: string,
    approve: boolean,
    note: string | undefined,
    key: string,
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    return this.idempotency.run(actor.id, `adjustment:${id}`, key, { approve, note }, async () => {
      const row = await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM financial_adjustments WHERE id = ${id}::uuid FOR UPDATE`;
        if (locked.length === 0) throw Errors.notFound();
        const adjustment = await tx.financialAdjustment.findUniqueOrThrow({ where: { id } });
        if (adjustment.status !== 'PENDING_APPROVAL') throw Errors.invalidState('Already decided');
        await this.approvals.assertCanApprove(
          tx,
          actor,
          adjustment.requestedById,
          adjustment.amount,
        );
        let journalEntryId: string | null = null;
        if (approve) {
          const merchant = accounts.merchantBalance(adjustment.merchantId);
          const expense = accounts.adjustmentExpense();
          const entry = await this.ledger.post(tx, {
            kind: 'MERCHANT_ADJUSTMENT',
            sourceType: 'financial_adjustment',
            sourceId: id,
            createdById: actor.id,
            description: adjustment.reason,
            lines:
              adjustment.type === 'MERCHANT_CREDIT'
                ? [debit(expense, adjustment.amount), credit(merchant, adjustment.amount)]
                : [debit(merchant, adjustment.amount), credit(expense, adjustment.amount)],
          });
          journalEntryId = entry.id;
        }
        return tx.financialAdjustment.update({
          where: { id },
          data: {
            status: approve ? 'APPLIED' : 'REJECTED',
            decidedById: actor.id,
            decidedAt: new Date(),
            decisionNote: note ?? null,
            journalEntryId,
          },
          include: adjustmentInclude,
        });
      });
      await this.audit.record({
        action: approve ? 'ADJUSTMENT_APPROVED' : 'ADJUSTMENT_REJECTED',
        actorUserId: actor.id,
        targetUserId: row.merchantId,
        meta,
        metadata: { adjustmentId: id, note: note ?? null },
      });
      return this.toItem(row);
    });
  }
}
