import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type CashChannel } from '@coobra/database';
import {
  CASH_COUNT_ROLES,
  type ConfirmSettlementInput,
  type DriverBalanceRow,
  type DriverFinanceSummary,
  type DriverRepaymentInput,
  type DriverShortageInput,
  type DriverShortageItem,
  type SettlementItem,
  type UnclearedCollection,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalService } from './approval.service.js';
import { IdempotencyService } from './idempotency.service.js';
import {
  accounts,
  credit,
  debit,
  decimal,
  LedgerService,
  type PostingLine,
} from './ledger.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (value: Prisma.Decimal) => value.toFixed(2);

interface Allocation {
  collectionId: string;
  shipmentId: string;
  merchantId: string;
  amount: Prisma.Decimal;
}

const settlementInclude = {
  driver: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true, role: true } },
  decidedBy: { select: { id: true, fullName: true, role: true } },
  clearings: {
    include: {
      collection: { select: { shipment: { select: { id: true, trackingNumber: true } } } },
    },
  },
} as const satisfies Prisma.DriverSettlementInclude;

function toSettlementItem(
  row: Prisma.DriverSettlementGetPayload<{ include: typeof settlementInclude }>,
): SettlementItem {
  return {
    id: row.id,
    driver: row.driver,
    status: row.status,
    declaredAmount: money(row.declaredAmount),
    countedAmount: row.countedAmount ? money(row.countedAmount) : null,
    discrepancy: row.countedAmount ? money(row.declaredAmount.minus(row.countedAmount)) : null,
    channel: row.channel,
    note: row.note,
    submittedBy: row.submittedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    clearings: row.clearings.map((clearing) => ({
      shipment: clearing.collection.shipment,
      amount: money(clearing.amount),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

const shortageInclude = {
  driver: { select: { id: true, fullName: true } },
  proposedBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.DriverCashShortageInclude;

function toShortageItem(
  row: Prisma.DriverCashShortageGetPayload<{ include: typeof shortageInclude }>,
): DriverShortageItem {
  return {
    id: row.id,
    driver: row.driver,
    amount: money(row.amount),
    responsibility: row.responsibility,
    reason: row.reason,
    status: row.status,
    proposedBy: row.proposedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Driver cash: settlements (partial allowed), cash shortages and repayments. Every clearing is
 * allocated under row locks to specific collections, so the same cash can never be cleared twice.
 */
@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Accountant-only cash decisions, never by the driver or by whoever registered the
   * hand-over. The routes allow only CASH_COUNT_ROLES; this repeats it for every caller.
   */
  private assertCanDecideSettlement(
    actor: Actor,
    settlement: { driverId: string; submittedById: string },
  ) {
    if (!(CASH_COUNT_ROLES as readonly UserRole[]).includes(actor.role)) throw Errors.forbidden();
    if (settlement.driverId === actor.id || settlement.submittedById === actor.id) {
      throw Errors.selfApprovalForbidden();
    }
  }

  private async assertDriver(db: Tx, driverId: string) {
    if (!UUID_PATTERN.test(driverId)) throw Errors.shipmentDriverInvalid();
    const driver = await db.user.findFirst({ where: { id: driverId, role: 'DRIVER' } });
    if (!driver) throw Errors.shipmentDriverInvalid();
  }

  /**
   * Sum of collected cash not yet handed over or resolved (the driver's custody). Only
   * collections posted to the ledger count: Phase 2 records join once the backfill posts them.
   */
  private async uncleared(db: Tx, driverId: string): Promise<Prisma.Decimal> {
    const rows = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(c.collected_amount - c.cleared_amount)::text AS total
      FROM cod_collections c
      WHERE c.driver_id = ${driverId}::uuid
        AND EXISTS (SELECT 1 FROM journal_entries e
                    WHERE e.source_type = 'cod_collection' AND e.source_id = c.id::text)`;
    return decimal(rows[0]?.total ?? 0);
  }

  /**
   * Clears \`amount\` from the driver's uncleared collections (selected shipments, or oldest
   * first), locking them. Fails if there is not enough uncleared cash.
   */
  private async allocate(tx: Tx, driverId: string, amount: Prisma.Decimal, shipmentIds?: string[]) {
    await this.ledger.lock(tx, accounts.driverCustody(driverId));
    const rows = shipmentIds?.length
      ? await tx.$queryRaw<
          { id: string; shipment_id: string; merchant_id: string; remaining: string }[]
        >`
          SELECT c.id, c.shipment_id, s.merchant_id, (c.collected_amount - c.cleared_amount)::text AS remaining
          FROM cod_collections c JOIN shipments s ON s.id = c.shipment_id
          WHERE c.driver_id = ${driverId}::uuid AND c.cleared_amount < c.collected_amount
            AND c.shipment_id = ANY(${shipmentIds}::uuid[])
            AND EXISTS (SELECT 1 FROM journal_entries e
                        WHERE e.source_type = 'cod_collection' AND e.source_id = c.id::text)
          ORDER BY c.recorded_at, c.id FOR UPDATE OF c`
      : await tx.$queryRaw<
          { id: string; shipment_id: string; merchant_id: string; remaining: string }[]
        >`
          SELECT c.id, c.shipment_id, s.merchant_id, (c.collected_amount - c.cleared_amount)::text AS remaining
          FROM cod_collections c JOIN shipments s ON s.id = c.shipment_id
          WHERE c.driver_id = ${driverId}::uuid AND c.cleared_amount < c.collected_amount
            AND EXISTS (SELECT 1 FROM journal_entries e
                        WHERE e.source_type = 'cod_collection' AND e.source_id = c.id::text)
          ORDER BY c.recorded_at, c.id FOR UPDATE OF c`;
    let left = amount;
    const allocations: Allocation[] = [];
    for (const row of rows) {
      if (!left.greaterThan(0)) break;
      const part = Prisma.Decimal.min(left, decimal(row.remaining));
      allocations.push({
        collectionId: row.id,
        shipmentId: row.shipment_id,
        merchantId: row.merchant_id,
        amount: part,
      });
      left = left.minus(part);
    }
    if (left.greaterThan(0)) {
      throw Errors.insufficientFunds(
        'The amount is more than the driver’s uncleared cash for this selection',
      );
    }
    for (const allocation of allocations) {
      await tx.codCollection.update({
        where: { id: allocation.collectionId },
        data: { clearedAmount: { increment: allocation.amount } },
      });
    }
    return allocations;
  }

  /** Releases the merchants' pending COD covered by the allocations to their balances. */
  private releaseLines(allocations: Allocation[]): PostingLine[] {
    return allocations.flatMap((allocation) => [
      debit(
        accounts.merchantPending(allocation.merchantId),
        allocation.amount,
        allocation.shipmentId,
      ),
      credit(
        accounts.merchantBalance(allocation.merchantId),
        allocation.amount,
        allocation.shipmentId,
      ),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Settlements
  // ---------------------------------------------------------------------------

  /** Driver (own) or finance user (at the counter) submits a settlement. One open per driver. */
  submit(
    actor: Actor,
    driverId: string,
    input: { declaredAmount: string; note?: string },
    key: string,
    meta: RequestMeta,
  ) {
    return this.idempotency.run(actor.id, `settlement-submit:${driverId}`, key, input, async () => {
      const settlement = await this.prisma.client.$transaction(async (tx) => {
        await this.assertDriver(tx, driverId);
        await this.ledger.lock(tx, accounts.driverCustody(driverId));
        const open = await tx.driverSettlement.count({ where: { driverId, status: 'SUBMITTED' } });
        if (open > 0) throw Errors.invalidState('A settlement is already waiting for confirmation');
        if (decimal(input.declaredAmount).greaterThan(await this.uncleared(tx, driverId))) {
          throw Errors.insufficientFunds(
            'The declared amount is more than the driver’s cash custody',
          );
        }
        return tx.driverSettlement.create({
          data: {
            driverId,
            declaredAmount: input.declaredAmount,
            note: input.note ?? null,
            submittedById: actor.id,
          },
          include: settlementInclude,
        });
      });
      await this.audit.record({
        action: 'SETTLEMENT_SUBMITTED',
        actorUserId: actor.id,
        targetUserId: driverId,
        meta,
        metadata: {
          settlementId: settlement.id,
          declaredAmount: money(decimal(input.declaredAmount)),
          submittedByRole: actor.role,
        },
      });
      return toSettlementItem(settlement);
    });
  }

  confirm(actor: Actor, id: string, input: ConfirmSettlementInput, key: string, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    return this.idempotency.run(actor.id, `settlement-confirm:${id}`, key, input, async () => {
      const settlement = await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM driver_settlements WHERE id = ${id}::uuid FOR UPDATE`;
        if (locked.length === 0) throw Errors.notFound();
        const current = await tx.driverSettlement.findUniqueOrThrow({ where: { id } });
        if (current.status !== 'SUBMITTED')
          throw Errors.invalidState('This settlement was already decided');
        this.assertCanDecideSettlement(actor, current);
        const counted = decimal(input.countedAmount);
        if (!counted.greaterThan(0) || counted.greaterThan(current.declaredAmount)) {
          throw Errors.validation({ countedAmount: 'validation.finance.counted' });
        }
        const allocations = await this.allocate(tx, current.driverId, counted, input.shipmentIds);
        const entry = await this.ledger.post(tx, {
          kind: 'DRIVER_SETTLEMENT',
          sourceType: 'driver_settlement',
          sourceId: id,
          createdById: actor.id,
          description: `Driver settlement (${input.channel})`,
          lines: [
            debit(accounts.companyCash(input.channel as CashChannel), counted),
            credit(accounts.driverCustody(current.driverId), counted),
            ...this.releaseLines(allocations),
          ],
        });
        await tx.cashClearing.createMany({
          data: allocations.map((allocation) => ({
            collectionId: allocation.collectionId,
            amount: allocation.amount,
            settlementId: id,
          })),
        });
        return tx.driverSettlement.update({
          where: { id },
          data: {
            status: 'CONFIRMED',
            countedAmount: counted,
            channel: input.channel,
            decidedById: actor.id,
            decidedAt: new Date(),
            decisionNote: input.note ?? null,
            journalEntryId: entry.id,
          },
          include: settlementInclude,
        });
      });
      await this.audit.record({
        action: 'SETTLEMENT_CONFIRMED',
        actorUserId: actor.id,
        targetUserId: settlement.driverId,
        meta,
        metadata: {
          settlementId: id,
          submittedById: settlement.submittedById,
          declaredAmount: money(settlement.declaredAmount),
          countedAmount: money(decimal(input.countedAmount)),
          discrepancy: money(settlement.declaredAmount.minus(decimal(input.countedAmount))),
          channel: input.channel,
          submittedAt: settlement.createdAt.toISOString(),
          decidedAt: settlement.decidedAt?.toISOString() ?? null,
        },
      });
      return toSettlementItem(settlement);
    });
  }

  async reject(actor: Actor, id: string, note: string, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const settlement = await this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM driver_settlements WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw Errors.notFound();
      const current = await tx.driverSettlement.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'SUBMITTED')
        throw Errors.invalidState('This settlement was already decided');
      this.assertCanDecideSettlement(actor, current);
      return tx.driverSettlement.update({
        where: { id },
        data: {
          status: 'REJECTED',
          decidedById: actor.id,
          decidedAt: new Date(),
          decisionNote: note,
        },
        include: settlementInclude,
      });
    });
    await this.audit.record({
      action: 'SETTLEMENT_REJECTED',
      actorUserId: actor.id,
      targetUserId: settlement.driverId,
      meta,
      metadata: {
        settlementId: id,
        submittedById: settlement.submittedById,
        declaredAmount: money(settlement.declaredAmount),
        note,
      },
    });
    return toSettlementItem(settlement);
  }

  async listSettlements(filter: {
    status?: 'SUBMITTED' | 'CONFIRMED' | 'REJECTED';
    driverId?: string;
  }) {
    const rows = await this.prisma.client.driverSettlement.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.driverId ? { driverId: filter.driverId } : {}),
      },
      include: settlementInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toSettlementItem);
  }

  // ---------------------------------------------------------------------------
  // Driver cash shortages and repayments
  // ---------------------------------------------------------------------------

  /** An accountant records a counted cash discrepancy; a second finance user approves it. */
  async proposeShortage(actor: Actor, input: DriverShortageInput, meta: RequestMeta) {
    if (!(CASH_COUNT_ROLES as readonly UserRole[]).includes(actor.role)) throw Errors.forbidden();
    const db = this.prisma.client;
    await this.assertDriver(db, input.driverId);
    if (decimal(input.amount).greaterThan(await this.uncleared(db, input.driverId))) {
      throw Errors.insufficientFunds('The amount is more than the driver’s cash custody');
    }
    const row = await db.driverCashShortage.create({
      data: { ...input, proposedById: actor.id },
      include: shortageInclude,
    });
    await this.audit.record({
      action: 'DRIVER_SHORTAGE_PROPOSED',
      actorUserId: actor.id,
      targetUserId: input.driverId,
      meta,
      metadata: {
        shortageId: row.id,
        amount: input.amount,
        responsibility: input.responsibility,
        reason: input.reason,
      },
    });
    return toShortageItem(row);
  }

  decideShortage(
    actor: Actor,
    id: string,
    approve: boolean,
    note: string | undefined,
    key: string,
    meta: RequestMeta,
  ) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    return this.idempotency.run(
      actor.id,
      `driver-shortage:${id}`,
      key,
      { approve, note },
      async () => {
        const row = await this.prisma.client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM driver_cash_shortages WHERE id = ${id}::uuid FOR UPDATE`;
          if (locked.length === 0) throw Errors.notFound();
          const shortage = await tx.driverCashShortage.findUniqueOrThrow({ where: { id } });
          if (shortage.status !== 'PENDING_APPROVAL') throw Errors.invalidState('Already decided');
          await this.approvals.assertCanApprove(tx, actor, shortage.proposedById, shortage.amount);
          let journalEntryId: string | null = null;
          if (approve) {
            const allocations = await this.allocate(tx, shortage.driverId, shortage.amount);
            const bearer =
              shortage.responsibility === 'DRIVER_LIABLE'
                ? accounts.driverReceivable(shortage.driverId)
                : accounts.driverCashLossExpense();
            const entry = await this.ledger.post(tx, {
              kind: 'DRIVER_CASH_SHORTAGE',
              sourceType: 'driver_cash_shortage',
              sourceId: id,
              createdById: actor.id,
              description: `Driver cash shortage (${shortage.responsibility})`,
              lines: [
                debit(bearer, shortage.amount),
                credit(accounts.driverCustody(shortage.driverId), shortage.amount),
                // The recipients paid: the merchants' COD is released regardless of who bears the loss.
                ...this.releaseLines(allocations),
              ],
            });
            journalEntryId = entry.id;
            await tx.cashClearing.createMany({
              data: allocations.map((allocation) => ({
                collectionId: allocation.collectionId,
                amount: allocation.amount,
                driverShortageId: id,
              })),
            });
          }
          return tx.driverCashShortage.update({
            where: { id },
            data: {
              status: approve ? 'APPLIED' : 'REJECTED',
              decidedById: actor.id,
              decidedAt: new Date(),
              decisionNote: note ?? null,
              journalEntryId,
            },
            include: shortageInclude,
          });
        });
        await this.audit.record({
          action: approve ? 'DRIVER_SHORTAGE_APPROVED' : 'DRIVER_SHORTAGE_REJECTED',
          actorUserId: actor.id,
          targetUserId: row.driverId,
          meta,
          metadata: { shortageId: id, note: note ?? null },
        });
        return toShortageItem(row);
      },
    );
  }

  async listShortages() {
    const rows = await this.prisma.client.driverCashShortage.findMany({
      include: shortageInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toShortageItem);
  }

  recordRepayment(actor: Actor, input: DriverRepaymentInput, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, 'driver-repayment', key, input, async () => {
      const id = randomUUID();
      await this.prisma.client.$transaction(async (tx) => {
        await this.assertDriver(tx, input.driverId);
        const receivable = accounts.driverReceivable(input.driverId);
        await this.ledger.lock(tx, receivable);
        if (decimal(input.amount).greaterThan(await this.ledger.balance(tx, receivable))) {
          throw Errors.insufficientFunds('The amount is more than what the driver owes');
        }
        const entry = await this.ledger.post(tx, {
          kind: 'DRIVER_REPAYMENT',
          sourceType: 'driver_repayment',
          sourceId: id,
          createdById: actor.id,
          description: 'Driver repayment',
          lines: [
            debit(accounts.companyCash(input.channel), input.amount),
            credit(receivable, input.amount),
          ],
        });
        await tx.driverRepayment.create({
          data: {
            id,
            driverId: input.driverId,
            amount: input.amount,
            channel: input.channel,
            note: input.note ?? null,
            recordedById: actor.id,
            journalEntryId: entry.id,
          },
        });
      });
      await this.audit.record({
        action: 'DRIVER_REPAYMENT_RECORDED',
        actorUserId: actor.id,
        targetUserId: input.driverId,
        meta,
        metadata: { repaymentId: id, amount: input.amount, channel: input.channel },
      });
      return { id };
    });
  }

  // ---------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------

  async driverSummary(driverId: string): Promise<DriverFinanceSummary> {
    const db = this.prisma.client;
    const all = await db.codCollection.findMany({
      where: { driverId, collectedAmount: { gt: 0 } },
      include: { shipment: { select: { id: true, trackingNumber: true } } },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    // Same rule as custody: only collections already posted to the ledger.
    const posted = new Set(
      (
        await db.journalEntry.findMany({
          where: { sourceType: 'cod_collection', sourceId: { in: all.map((c) => c.id) } },
          select: { sourceId: true },
        })
      ).map((entry) => entry.sourceId),
    );
    const collections = all.filter((collection) => posted.has(collection.id));
    const uncleared: UnclearedCollection[] = collections
      .filter((collection) => collection.clearedAmount.lessThan(collection.collectedAmount))
      .map((collection) => ({
        collectionId: collection.id,
        shipment: collection.shipment,
        amount: money(collection.collectedAmount),
        uncleared: money(collection.collectedAmount.minus(collection.clearedAmount)),
        recordedAt: collection.recordedAt.toISOString(),
      }));
    const settlements = await this.listSettlements({ driverId });
    return {
      custody: money(await this.ledger.balance(db, accounts.driverCustody(driverId))),
      receivable: money(await this.ledger.balance(db, accounts.driverReceivable(driverId))),
      pendingSettlement:
        settlements.find((settlement) => settlement.status === 'SUBMITTED') ?? null,
      uncleared,
      settlements: settlements.slice(0, 50),
    };
  }

  async driverBalances(): Promise<DriverBalanceRow[]> {
    const db = this.prisma.client;
    const drivers = await db.user.findMany({
      where: { role: 'DRIVER' },
      select: { id: true, fullName: true, phone: true },
      orderBy: { fullName: 'asc' },
    });
    const pending = await db.driverSettlement.findMany({ where: { status: 'SUBMITTED' } });
    const rows: DriverBalanceRow[] = [];
    for (const driver of drivers) {
      const custody = await this.ledger.balance(db, accounts.driverCustody(driver.id));
      const receivable = await this.ledger.balance(db, accounts.driverReceivable(driver.id));
      const open = pending.find((settlement) => settlement.driverId === driver.id);
      rows.push({
        driver,
        custody: money(custody),
        receivable: money(receivable),
        pendingSettlement: open ? money(open.declaredAmount) : null,
      });
    }
    return rows.sort(
      (a, b) =>
        decimal(b.custody).comparedTo(decimal(a.custody)) ||
        a.driver.fullName.localeCompare(b.driver.fullName),
    );
  }
}
