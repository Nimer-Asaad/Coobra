import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import type {
  FinanceOverview,
  JournalEntryItem,
  Paginated,
  ReconciliationCheck,
} from '@coobra/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { decimal } from './ledger.service.js';
import { PayoutsService } from './payouts.service.js';
import { SettlementsService } from './settlements.service.js';

const money = (value: Prisma.Decimal) => value.toFixed(2);

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Arabic correctly. */
function csv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Financial reporting and reconciliation. Every figure comes from the ledger; reconciliation
 * recomputes the same figures from the operational tables and reports any difference.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly payouts: PayoutsService,
  ) {}

  /** Signed balance totals per account purpose. */
  private async totalsByPurpose(from?: Date, to?: Date) {
    const rows = await this.prisma.client.$queryRaw<
      { purpose: string; type: string; debits: string; credits: string }[]
    >`
      SELECT a.purpose::text AS purpose, a.type::text AS type,
             COALESCE(SUM(CASE WHEN l.side = 'DEBIT' THEN l.amount END), 0)::text AS debits,
             COALESCE(SUM(CASE WHEN l.side = 'CREDIT' THEN l.amount END), 0)::text AS credits
      FROM financial_accounts a
      JOIN journal_lines l ON l.account_id = a.id
      WHERE (${from ?? null}::timestamp IS NULL OR l.created_at >= ${from ?? null}::timestamp)
        AND (${to ?? null}::timestamp IS NULL OR l.created_at < ${to ?? null}::timestamp)
      GROUP BY a.purpose, a.type`;
    const totals = new Map<string, Prisma.Decimal>();
    for (const row of rows) {
      const debitNormal = row.type === 'ASSET' || row.type === 'EXPENSE';
      totals.set(
        row.purpose,
        debitNormal
          ? decimal(row.debits).minus(row.credits)
          : decimal(row.credits).minus(row.debits),
      );
    }
    return (purpose: string) => totals.get(purpose) ?? decimal(0);
  }

  async reconciliation(): Promise<ReconciliationCheck[]> {
    const db = this.prisma.client;
    const checks: ReconciliationCheck[] = [];
    const [trial] = await db.$queryRaw<{ debits: string | null; credits: string | null }[]>`
      SELECT SUM(CASE WHEN side = 'DEBIT' THEN amount END)::text AS debits,
             SUM(CASE WHEN side = 'CREDIT' THEN amount END)::text AS credits FROM journal_lines`;
    const debits = decimal(trial?.debits ?? 0);
    const credits = decimal(trial?.credits ?? 0);
    checks.push({
      key: 'TRIAL_BALANCE',
      ledger: money(debits),
      operational: money(credits),
      difference: money(debits.minus(credits)),
    });

    const total = await this.totalsByPurpose();
    const [uncleared] = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(c.collected_amount - c.cleared_amount)::text AS total
      FROM cod_collections c
      WHERE EXISTS (SELECT 1 FROM journal_entries e WHERE e.source_id = c.id::text AND e.source_type = 'cod_collection')`;
    const custodyOps = decimal(uncleared?.total ?? 0);
    checks.push({
      key: 'DRIVER_CUSTODY',
      ledger: money(total('DRIVER_CUSTODY')),
      operational: money(custodyOps),
      difference: money(total('DRIVER_CUSTODY').minus(custodyOps)),
    });
    checks.push({
      key: 'MERCHANT_COD_PENDING',
      ledger: money(total('MERCHANT_COD_PENDING')),
      operational: money(custodyOps),
      difference: money(total('MERCHANT_COD_PENDING').minus(custodyOps)),
    });
    const [paid] = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(amount)::text AS total FROM merchant_payouts WHERE status = 'PAID'`;
    const [payoutLines] = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(l.amount)::text AS total FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.kind = 'MERCHANT_PAYOUT' AND l.side = 'DEBIT'`;
    const paidOps = decimal(paid?.total ?? 0);
    const paidLedger = decimal(payoutLines?.total ?? 0);
    checks.push({
      key: 'MERCHANT_PAYOUTS',
      ledger: money(paidLedger),
      operational: money(paidOps),
      difference: money(paidLedger.minus(paidOps)),
    });
    return checks;
  }

  async overview(from?: Date, to?: Date): Promise<FinanceOverview> {
    const db = this.prisma.client;
    const all = await this.totalsByPurpose();
    const period = await this.totalsByPurpose(from, to);
    const merchantBalances = await db.$queryRaw<{ owed: string | null; owing: string | null }[]>`
      SELECT SUM(GREATEST(bal, 0))::text AS owed, SUM(GREATEST(-bal, 0))::text AS owing FROM (
        SELECT SUM(CASE WHEN l.side = 'CREDIT' THEN l.amount ELSE -l.amount END) AS bal
        FROM financial_accounts a JOIN journal_lines l ON l.account_id = a.id
        WHERE a.purpose = 'MERCHANT_BALANCE' GROUP BY a.id) balances`;
    const reserved = await db.merchantPayout.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
    });
    const [outstandingCod] = await db.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(cod_amount - cod_collected_amount)::text AS total FROM shipments WHERE cod_status = 'PARTIAL'`;
    return {
      companyCash: {
        HUB: money(all('COMPANY_CASH_HUB')),
        BANK: money(all('COMPANY_BANK')),
        EWALLET: money(all('COMPANY_EWALLET')),
      },
      driverCustody: money(all('DRIVER_CUSTODY')),
      driverReceivables: money(all('DRIVER_RECEIVABLE')),
      merchantPending: money(all('MERCHANT_COD_PENDING')),
      merchantOwed: money(decimal(merchantBalances[0]?.owed ?? 0)),
      merchantOwing: money(decimal(merchantBalances[0]?.owing ?? 0)),
      reservedPayouts: money(reserved._sum.amount ?? decimal(0)),
      recipientOutstanding: money(decimal(outstandingCod?.total ?? 0)),
      period: {
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        deliveryFees: money(period('DELIVERY_FEE_REVENUE')),
        returnFees: money(period('RETURN_FEE_REVENUE')),
        codShortfallExpense: money(period('COD_SHORTFALL_EXPENSE')),
        driverCashLossExpense: money(period('DRIVER_CASH_LOSS_EXPENSE')),
        adjustmentExpense: money(period('ADJUSTMENT_EXPENSE')),
      },
      queues: {
        shortfallsOpen: await db.codShortfall.count({ where: { status: { not: 'RESOLVED' } } }),
        settlementsSubmitted: await db.driverSettlement.count({ where: { status: 'SUBMITTED' } }),
        driverShortagesPending: await db.driverCashShortage.count({
          where: { status: 'PENDING_APPROVAL' },
        }),
        payoutsPending: await db.merchantPayout.count({ where: { status: 'PENDING_APPROVAL' } }),
        payoutsApproved: await db.merchantPayout.count({ where: { status: 'APPROVED' } }),
        adjustmentsPending: await db.financialAdjustment.count({
          where: { status: 'PENDING_APPROVAL' },
        }),
        feeCorrectionsPending: await db.shipmentFeeOverride.count({
          where: { phase: 'POST_DELIVERY', status: 'PENDING_APPROVAL' },
        }),
        returnsFeeUnconfigured: await db.returnRecord.count({
          where: { feeStatus: 'RETURN_FEE_UNCONFIGURED' },
        }),
      },
      reconciliation: await this.reconciliation(),
    };
  }

  async journal(page: number, pageSize: number): Promise<Paginated<JournalEntryItem>> {
    const db = this.prisma.client;
    const [total, rows] = await Promise.all([
      db.journalEntry.count(),
      db.journalEntry.findMany({
        include: {
          createdBy: { select: { id: true, fullName: true } },
          lines: { include: { account: true, shipment: { select: { trackingNumber: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        description: entry.description,
        reversalOfId: entry.reversalOfId,
        createdBy: entry.createdBy,
        createdAt: entry.createdAt.toISOString(),
        lines: entry.lines.map((line) => ({
          account: line.account.code,
          purpose: line.account.purpose,
          side: line.side,
          amount: money(line.amount),
          trackingNumber: line.shipment?.trackingNumber ?? null,
        })),
      })),
    };
  }

  async csvReport(name: string): Promise<string | null> {
    const db = this.prisma.client;
    switch (name) {
      case 'merchant-balances': {
        const rows = await this.payouts.merchantBalances();
        return csv(
          ['merchant', 'pending_cod', 'balance', 'reserved', 'available'],
          rows.map((row) => [
            row.merchant.businessName,
            row.pending,
            row.balance,
            row.reserved,
            row.available,
          ]),
        );
      }
      case 'driver-balances': {
        const rows = await this.settlements.driverBalances();
        return csv(
          ['driver', 'phone', 'cash_custody', 'receivable', 'pending_settlement'],
          rows.map((row) => [
            row.driver.fullName,
            row.driver.phone,
            row.custody,
            row.receivable,
            row.pendingSettlement,
          ]),
        );
      }
      case 'journal': {
        const rows = await db.journalLine.findMany({
          include: { entry: true, account: true, shipment: { select: { trackingNumber: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 50_000,
        });
        return csv(
          [
            'date',
            'entry_id',
            'kind',
            'account',
            'side',
            'amount',
            'tracking_number',
            'description',
          ],
          rows.map((line) => [
            line.createdAt.toISOString(),
            line.entryId,
            line.entry.kind,
            line.account.code,
            line.side,
            money(line.amount),
            line.shipment?.trackingNumber ?? null,
            line.entry.description,
          ]),
        );
      }
      case 'delivered-shipments': {
        const rows = await db.shipment.findMany({
          where: { status: { in: ['DELIVERED', 'RETURNED'] } },
          include: { merchant: { include: { merchantProfile: true } }, returnRecord: true },
          orderBy: { createdAt: 'asc' },
          take: 50_000,
        });
        return csv(
          [
            'tracking_number',
            'status',
            'merchant',
            'cod_amount',
            'cod_collected',
            'cod_status',
            'delivery_fee',
            'return_fee',
            'delivered_at',
          ],
          rows.map((row) => [
            row.trackingNumber,
            row.status,
            row.merchant.merchantProfile?.businessName ?? row.merchant.fullName,
            money(row.codAmount),
            money(row.codCollectedAmount),
            row.codStatus,
            row.deliveryFee ? money(row.deliveryFee) : null,
            row.returnRecord?.feeAmount ? money(row.returnRecord.feeAmount) : null,
            row.deliveredAt?.toISOString() ?? null,
          ]),
        );
      }
      default:
        return null;
    }
  }
}
