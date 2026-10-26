import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import {
  FINANCE_ROLES,
  PAYMENT_METHOD_CHANNEL,
  type CreatePayoutInput,
  type MarkPayoutPaidInput,
  type MerchantBalanceRow,
  type MerchantFinanceSummary,
  type MerchantPaymentInput,
  type PayoutItem,
  type PayoutRequestInput,
  type TreasuryTransferInput,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { accounts, credit, debit, decimal, LedgerService, ZERO } from './ledger.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (value: Prisma.Decimal) => value.toFixed(2);
const person = { select: { id: true, fullName: true } } as const;

const payoutInclude = {
  merchant: {
    select: { id: true, fullName: true, merchantProfile: { select: { businessName: true } } },
  },
  createdBy: person,
  approvedBy: person,
  paidBy: person,
  cancelledBy: person,
} as const satisfies Prisma.MerchantPayoutInclude;

function toPayoutItem(
  row: Prisma.MerchantPayoutGetPayload<{ include: typeof payoutInclude }>,
): PayoutItem {
  return {
    id: row.id,
    merchant: {
      id: row.merchant.id,
      fullName: row.merchant.fullName,
      businessName: row.merchant.merchantProfile?.businessName ?? row.merchant.fullName,
    },
    amount: money(row.amount),
    method: row.method,
    status: row.status,
    requestedByMerchant: row.requestedByMerchant,
    note: row.note,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    paidBy: row.paidBy,
    paidAt: row.paidAt?.toISOString() ?? null,
    reference: row.reference,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Merchant payouts with separation of duties (the approver is never the creator; no exception
 * in Phase 3), merchant payments received, and treasury transfers between company accounts.
 * Payouts never exceed the merchant's funded balance or the company account's cash.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /** Funded balance, approved-unpaid reservations and what can still be paid out. */
  private async funds(db: Tx, merchantId: string, excludePayoutId?: string) {
    const balance = await this.ledger.balance(db, accounts.merchantBalance(merchantId));
    const reserved = await db.merchantPayout.aggregate({
      where: {
        merchantId,
        status: 'APPROVED',
        ...(excludePayoutId ? { id: { not: excludePayoutId } } : {}),
      },
      _sum: { amount: true },
    });
    const reservedAmount = reserved._sum.amount ?? ZERO;
    const available = Prisma.Decimal.max(balance.minus(reservedAmount), ZERO);
    return { balance, reserved: reservedAmount, available };
  }

  async summary(merchantId: string): Promise<MerchantFinanceSummary> {
    const db = this.prisma.client;
    const { balance, reserved, available } = await this.funds(db, merchantId);
    const pending = await this.ledger.balance(db, accounts.merchantPending(merchantId));
    return {
      pending: money(pending),
      balance: money(balance),
      reserved: money(reserved),
      available: money(available),
      payouts: await this.list({ merchantId }),
    };
  }

  async merchantBalances(): Promise<MerchantBalanceRow[]> {
    const db = this.prisma.client;
    const merchants = await db.user.findMany({
      where: { role: 'MERCHANT' },
      select: { id: true, fullName: true, merchantProfile: { select: { businessName: true } } },
      orderBy: { fullName: 'asc' },
    });
    const rows: MerchantBalanceRow[] = [];
    for (const merchant of merchants) {
      const { balance, reserved, available } = await this.funds(db, merchant.id);
      const pending = await this.ledger.balance(db, accounts.merchantPending(merchant.id));
      rows.push({
        merchant: {
          id: merchant.id,
          fullName: merchant.fullName,
          businessName: merchant.merchantProfile?.businessName ?? merchant.fullName,
        },
        pending: money(pending),
        balance: money(balance),
        reserved: money(reserved),
        available: money(available),
      });
    }
    return rows;
  }

  async list(filter: { merchantId?: string; status?: PayoutItem['status'] }) {
    const rows = await this.prisma.client.merchantPayout.findMany({
      where: {
        ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      include: payoutInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toPayoutItem);
  }

  /** Finance user creates, or a merchant requests (own account only). */
  create(actor: Actor, input: CreatePayoutInput, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, 'payout-create', key, input, async () => {
      const merchant = await this.prisma.client.user.findFirst({
        where: { id: input.merchantId, role: 'MERCHANT', status: 'ACTIVE' },
      });
      if (!merchant) throw Errors.shipmentMerchantInvalid();
      const { available } = await this.funds(this.prisma.client, input.merchantId);
      if (decimal(input.amount).greaterThan(available)) {
        throw Errors.insufficientFunds('The payout is more than the merchant’s available balance');
      }
      const row = await this.prisma.client.merchantPayout.create({
        data: {
          merchantId: input.merchantId,
          amount: input.amount,
          method: input.method,
          note: input.note ?? null,
          requestedByMerchant: actor.role === 'MERCHANT',
          createdById: actor.id,
        },
        include: payoutInclude,
      });
      await this.audit.record({
        action: 'PAYOUT_CREATED',
        actorUserId: actor.id,
        targetUserId: input.merchantId,
        meta,
        metadata: {
          payoutId: row.id,
          amount: input.amount,
          method: input.method,
          requestedByMerchant: row.requestedByMerchant,
        },
      });
      return toPayoutItem(row);
    });
  }

  request(merchant: Actor, input: PayoutRequestInput, key: string, meta: RequestMeta) {
    return this.create(merchant, { ...input, merchantId: merchant.id }, key, meta);
  }

  private async lockPayout(tx: Tx, id: string) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM merchant_payouts WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw Errors.notFound();
    return tx.merchantPayout.findUniqueOrThrow({ where: { id } });
  }

  /** Separation of duties: never the creator. Reserves the amount from the available balance. */
  approve(actor: Actor, id: string, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, `payout-approve:${id}`, key, {}, async () => {
      const row = await this.prisma.client.$transaction(async (tx) => {
        const payout = await this.lockPayout(tx, id);
        if (!(FINANCE_ROLES as readonly UserRole[]).includes(actor.role)) throw Errors.forbidden();
        if (payout.status !== 'PENDING_APPROVAL')
          throw Errors.invalidState('This payout is not waiting for approval');
        if (payout.createdById === actor.id) throw Errors.selfApprovalForbidden();
        await this.ledger.lock(tx, accounts.merchantBalance(payout.merchantId));
        const { available } = await this.funds(tx, payout.merchantId, id);
        if (payout.amount.greaterThan(available)) {
          throw Errors.insufficientFunds(
            'The payout is more than the merchant’s available balance',
          );
        }
        return tx.merchantPayout.update({
          where: { id },
          data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
          include: payoutInclude,
        });
      });
      await this.audit.record({
        action: 'PAYOUT_APPROVED',
        actorUserId: actor.id,
        targetUserId: row.merchantId,
        meta,
        metadata: { payoutId: id, amount: money(row.amount) },
      });
      return toPayoutItem(row);
    });
  }

  /** Posts the payment: the merchant must still be funded and the company account must hold it. */
  markPaid(actor: Actor, id: string, input: MarkPayoutPaidInput, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, `payout-pay:${id}`, key, input, async () => {
      let row;
      try {
        row = await this.prisma.client.$transaction(async (tx) => {
          const payout = await this.lockPayout(tx, id);
          if (payout.status !== 'APPROVED')
            throw Errors.invalidState('Only approved payouts can be paid');
          const merchantAccount = accounts.merchantBalance(payout.merchantId);
          const companyAccount = accounts.companyCash(PAYMENT_METHOD_CHANNEL[payout.method]);
          await this.ledger.lock(tx, merchantAccount);
          await this.ledger.lock(tx, companyAccount);
          const { balance, reserved } = await this.funds(tx, payout.merchantId, id);
          if (payout.amount.greaterThan(balance.minus(reserved))) {
            throw Errors.insufficientFunds(
              'The merchant’s funded balance no longer covers this payout',
            );
          }
          if (payout.amount.greaterThan(await this.ledger.balance(tx, companyAccount))) {
            throw Errors.insufficientFunds(
              'The company account does not hold enough confirmed cash',
            );
          }
          const entry = await this.ledger.post(tx, {
            kind: 'MERCHANT_PAYOUT',
            sourceType: 'merchant_payout',
            sourceId: id,
            createdById: actor.id,
            description: `Payout ${payout.method} ${input.reference}`,
            lines: [debit(merchantAccount, payout.amount), credit(companyAccount, payout.amount)],
          });
          return tx.merchantPayout.update({
            where: { id },
            data: {
              status: 'PAID',
              paidById: actor.id,
              paidAt: new Date(),
              reference: input.reference,
              note: input.note ?? payout.note,
              journalEntryId: entry.id,
            },
            include: payoutInclude,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw Errors.validation({ reference: 'validation.finance.referenceTaken' });
        throw error;
      }
      await this.audit.record({
        action: 'PAYOUT_PAID',
        actorUserId: actor.id,
        targetUserId: row.merchantId,
        meta,
        metadata: {
          payoutId: id,
          amount: money(row.amount),
          method: row.method,
          reference: input.reference,
        },
      });
      return toPayoutItem(row);
    });
  }

  /** Finance users cancel unpaid payouts; merchants may withdraw their own pending requests. */
  async cancel(actor: Actor, id: string, reason: string, meta: RequestMeta) {
    const row = await this.prisma.client.$transaction(async (tx) => {
      const payout = await this.lockPayout(tx, id);
      if (actor.role === 'MERCHANT') {
        if (payout.merchantId !== actor.id) throw Errors.notFound();
        if (payout.status !== 'PENDING_APPROVAL')
          throw Errors.invalidState('Only pending requests can be withdrawn');
      } else if (payout.status === 'PAID' || payout.status === 'CANCELLED') {
        throw Errors.invalidState('Paid or cancelled payouts cannot be cancelled');
      }
      return tx.merchantPayout.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledById: actor.id,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
        include: payoutInclude,
      });
    });
    await this.audit.record({
      action: 'PAYOUT_CANCELLED',
      actorUserId: actor.id,
      targetUserId: row.merchantId,
      meta,
      metadata: { payoutId: id, reason },
    });
    return toPayoutItem(row);
  }

  recordMerchantPayment(actor: Actor, input: MerchantPaymentInput, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, 'merchant-payment', key, input, async () => {
      const id = randomUUID();
      await this.prisma.client.$transaction(async (tx) => {
        const merchant = await tx.user.findFirst({
          where: { id: input.merchantId, role: 'MERCHANT' },
        });
        if (!merchant) throw Errors.shipmentMerchantInvalid();
        const entry = await this.ledger.post(tx, {
          kind: 'MERCHANT_PAYMENT',
          sourceType: 'merchant_payment',
          sourceId: id,
          createdById: actor.id,
          description: `Payment from merchant ${input.reference ?? ''}`.trim(),
          lines: [
            debit(accounts.companyCash(input.channel), input.amount),
            credit(accounts.merchantBalance(input.merchantId), input.amount),
          ],
        });
        await tx.merchantPayment.create({
          data: {
            id,
            merchantId: input.merchantId,
            amount: input.amount,
            channel: input.channel,
            reference: input.reference ?? null,
            note: input.note ?? null,
            recordedById: actor.id,
            journalEntryId: entry.id,
          },
        });
      });
      await this.audit.record({
        action: 'MERCHANT_PAYMENT_RECORDED',
        actorUserId: actor.id,
        targetUserId: input.merchantId,
        meta,
        metadata: { paymentId: id, amount: input.amount, channel: input.channel },
      });
      return { id };
    });
  }

  transfer(actor: Actor, input: TreasuryTransferInput, key: string, meta: RequestMeta) {
    return this.idempotency.run(actor.id, 'treasury-transfer', key, input, async () => {
      const id = randomUUID();
      await this.prisma.client.$transaction(async (tx) => {
        const from = accounts.companyCash(input.fromChannel);
        await this.ledger.lock(tx, from);
        if (decimal(input.amount).greaterThan(await this.ledger.balance(tx, from))) {
          throw Errors.insufficientFunds('The source account does not hold this amount');
        }
        const entry = await this.ledger.post(tx, {
          kind: 'TREASURY_TRANSFER',
          sourceType: 'treasury_transfer',
          sourceId: id,
          createdById: actor.id,
          description: `${input.fromChannel} → ${input.toChannel}`,
          lines: [
            debit(accounts.companyCash(input.toChannel), input.amount),
            credit(from, input.amount),
          ],
        });
        await tx.treasuryTransfer.create({
          data: {
            id,
            fromChannel: input.fromChannel,
            toChannel: input.toChannel,
            amount: input.amount,
            reference: input.reference ?? null,
            recordedById: actor.id,
            journalEntryId: entry.id,
          },
        });
      });
      await this.audit.record({
        action: 'TREASURY_TRANSFER',
        actorUserId: actor.id,
        meta,
        metadata: { transferId: id, ...input },
      });
      return { id };
    });
  }
}
