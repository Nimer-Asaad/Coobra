import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type AccountPurpose,
  type AccountType,
  type EntrySide,
  type FinancialAccount,
  type JournalKind,
} from '@coobra/database';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';

type Tx = Prisma.TransactionClient;

const ACCOUNT_TYPES: Record<AccountPurpose, AccountType> = {
  COMPANY_CASH_HUB: 'ASSET',
  COMPANY_BANK: 'ASSET',
  COMPANY_EWALLET: 'ASSET',
  DRIVER_CUSTODY: 'ASSET',
  DRIVER_RECEIVABLE: 'ASSET',
  MERCHANT_COD_PENDING: 'LIABILITY',
  MERCHANT_BALANCE: 'LIABILITY',
  DELIVERY_FEE_REVENUE: 'REVENUE',
  RETURN_FEE_REVENUE: 'REVENUE',
  COD_SHORTFALL_EXPENSE: 'EXPENSE',
  DRIVER_CASH_LOSS_EXPENSE: 'EXPENSE',
  ADJUSTMENT_EXPENSE: 'EXPENSE',
};

const OWNED: readonly AccountPurpose[] = [
  'DRIVER_CUSTODY',
  'DRIVER_RECEIVABLE',
  'MERCHANT_COD_PENDING',
  'MERCHANT_BALANCE',
];

export interface AccountRef {
  purpose: AccountPurpose;
  ownerUserId?: string;
}

export interface PostingLine extends AccountRef {
  side: EntrySide;
  amount: Prisma.Decimal | string;
  shipmentId?: string;
}

export interface Posting {
  kind: JournalKind;
  sourceType: string;
  sourceId: string;
  createdById: string | null;
  description?: string;
  reversalOfId?: string;
  lines: PostingLine[];
}

export const ZERO = new Prisma.Decimal(0);
export const decimal = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value);

/** Debit/credit helpers that read like the ADR tables. */
export const debit = (
  account: AccountRef,
  amount: Prisma.Decimal | string,
  shipmentId?: string,
): PostingLine => ({
  ...account,
  side: 'DEBIT',
  amount,
  shipmentId,
});
export const credit = (
  account: AccountRef,
  amount: Prisma.Decimal | string,
  shipmentId?: string,
): PostingLine => ({
  ...account,
  side: 'CREDIT',
  amount,
  shipmentId,
});

export const accounts = {
  companyCash: (channel: 'HUB' | 'BANK' | 'EWALLET' = 'HUB'): AccountRef => ({
    purpose:
      channel === 'BANK'
        ? 'COMPANY_BANK'
        : channel === 'EWALLET'
          ? 'COMPANY_EWALLET'
          : 'COMPANY_CASH_HUB',
  }),
  driverCustody: (driverId: string): AccountRef => ({
    purpose: 'DRIVER_CUSTODY',
    ownerUserId: driverId,
  }),
  driverReceivable: (driverId: string): AccountRef => ({
    purpose: 'DRIVER_RECEIVABLE',
    ownerUserId: driverId,
  }),
  merchantPending: (merchantId: string): AccountRef => ({
    purpose: 'MERCHANT_COD_PENDING',
    ownerUserId: merchantId,
  }),
  merchantBalance: (merchantId: string): AccountRef => ({
    purpose: 'MERCHANT_BALANCE',
    ownerUserId: merchantId,
  }),
  deliveryFeeRevenue: (): AccountRef => ({ purpose: 'DELIVERY_FEE_REVENUE' }),
  returnFeeRevenue: (): AccountRef => ({ purpose: 'RETURN_FEE_REVENUE' }),
  codShortfallExpense: (): AccountRef => ({ purpose: 'COD_SHORTFALL_EXPENSE' }),
  driverCashLossExpense: (): AccountRef => ({ purpose: 'DRIVER_CASH_LOSS_EXPENSE' }),
  adjustmentExpense: (): AccountRef => ({ purpose: 'ADJUSTMENT_EXPENSE' }),
};

/**
 * Double-entry ledger. Entries are balanced (checked here and by a deferred database trigger),
 * append-only (database triggers), and unique per business source. Corrections are reversals.
 */
@Injectable()
export class LedgerService {
  accountCode({ purpose, ownerUserId }: AccountRef): string {
    if (OWNED.includes(purpose) !== Boolean(ownerUserId)) {
      throw new Error(`Account ${purpose} ${ownerUserId ? 'cannot' : 'must'} have an owner`);
    }
    return ownerUserId ? `${purpose}:${ownerUserId}` : purpose;
  }

  /** Finds or creates an account. ON CONFLICT keeps concurrent first postings from failing. */
  async account(tx: Tx, ref: AccountRef): Promise<FinancialAccount> {
    const code = this.accountCode(ref);
    const existing = await tx.financialAccount.findUnique({ where: { code } });
    if (existing) return existing;
    await tx.$executeRaw`
      INSERT INTO financial_accounts (id, code, purpose, type, owner_user_id)
      VALUES (gen_random_uuid(), ${code}, ${ref.purpose}::"AccountPurpose", ${ACCOUNT_TYPES[ref.purpose]}::"AccountType", ${ref.ownerUserId ?? null}::uuid)
      ON CONFLICT (code) DO NOTHING`;
    return tx.financialAccount.findUniqueOrThrow({ where: { code } });
  }

  /** Serialises writers on an account (e.g. payouts against one merchant balance). */
  async lock(tx: Tx, ref: AccountRef): Promise<FinancialAccount> {
    const account = await this.account(tx, ref);
    await tx.$queryRaw`SELECT id FROM financial_accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
    return account;
  }

  /** Signed balance in the account's natural direction (assets/expenses: debit − credit). */
  async balance(tx: Tx, ref: AccountRef): Promise<Prisma.Decimal> {
    const code = this.accountCode(ref);
    const account = await tx.financialAccount.findUnique({ where: { code } });
    if (!account) return ZERO;
    const sums = await tx.journalLine.groupBy({
      by: ['side'],
      where: { accountId: account.id },
      _sum: { amount: true },
    });
    const total = (side: EntrySide) => sums.find((row) => row.side === side)?._sum.amount ?? ZERO;
    const debitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
    return debitNormal
      ? total('DEBIT').minus(total('CREDIT'))
      : total('CREDIT').minus(total('DEBIT'));
  }

  async post(tx: Tx, posting: Posting) {
    const lines = posting.lines.map((line) => ({ ...line, amount: decimal(line.amount) }));
    if (lines.length < 2) throw new Error('A journal entry needs at least two lines');
    if (lines.some((line) => !line.amount.greaterThan(0) || line.amount.decimalPlaces() > 2)) {
      throw new Error('Journal amounts must be positive with at most two decimals');
    }
    const sum = (side: EntrySide) =>
      lines
        .filter((line) => line.side === side)
        .reduce((total, line) => total.plus(line.amount), ZERO);
    if (!sum('DEBIT').equals(sum('CREDIT'))) throw new Error('Journal entry is not balanced');

    try {
      const entry = await tx.journalEntry.create({
        data: {
          kind: posting.kind,
          sourceType: posting.sourceType,
          sourceId: posting.sourceId,
          reversalOfId: posting.reversalOfId ?? null,
          description: posting.description ?? null,
          createdById: posting.createdById,
        },
      });
      for (const line of lines) {
        const account = await this.account(tx, line);
        await tx.journalLine.create({
          data: {
            entryId: entry.id,
            accountId: account.id,
            side: line.side,
            amount: line.amount,
            shipmentId: line.shipmentId ?? null,
          },
        });
      }
      return entry;
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.duplicatePosting();
      throw error;
    }
  }

  /** Posts the mirror image of an entry. An entry can be reversed only once. */
  async reverse(tx: Tx, entryId: string, input: { createdById: string; description: string }) {
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { include: { account: true } } },
    });
    if (!original) throw Errors.notFound();
    if (original.kind === 'REVERSAL') throw Errors.invalidState('A reversal cannot be reversed');
    return this.post(tx, {
      kind: 'REVERSAL',
      sourceType: 'journal_entry',
      sourceId: original.id,
      reversalOfId: original.id,
      createdById: input.createdById,
      description: input.description,
      lines: original.lines.map((line) => ({
        purpose: line.account.purpose,
        ownerUserId: line.account.ownerUserId ?? undefined,
        side: line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amount: line.amount,
        shipmentId: line.shipmentId ?? undefined,
      })),
    });
  }
}
