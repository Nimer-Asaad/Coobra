import { Prisma, type PrismaClient } from '@coobra/database';
import { accounts, credit, debit, LedgerService } from './ledger.service.js';

export interface BackfillCollection {
  id: string;
  trackingNumber: string;
  driverId: string;
  merchantId: string;
  amount: string;
  recordedAt: string;
}

export interface BackfillFee {
  shipmentId: string;
  trackingNumber: string;
  merchantId: string;
  fee: string;
  deliveredAt: string | null;
}

export interface BackfillReport {
  executed: boolean;
  collections: BackfillCollection[];
  fees: BackfillFee[];
  totals: { collections: string; fees: string };
}

const LOCK_KEY = 'coobra-phase2-backfill';

/**
 * Finds Phase 2 COD collections and delivery fees that have no ledger entry and, only when
 * \`execute\` is true, posts them as PHASE2_BACKFILL entries. Idempotent: anything with an
 * entry is skipped, and one run at a time holds an advisory lock.
 */
export async function runPhase2Backfill(prisma: PrismaClient, { execute }: { execute: boolean }) {
  const ledger = new LedgerService();
  return prisma.$transaction(
    async (tx): Promise<BackfillReport> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      const collections = await tx.$queryRaw<
        {
          id: string;
          tracking_number: string;
          driver_id: string;
          merchant_id: string;
          amount: string;
          recorded_at: Date;
        }[]
      >`
        SELECT c.id, s.tracking_number, c.driver_id, s.merchant_id,
               c.collected_amount::text AS amount, c.recorded_at
        FROM cod_collections c JOIN shipments s ON s.id = c.shipment_id
        WHERE c.collected_amount > 0
          AND NOT EXISTS (
            SELECT 1 FROM journal_entries e
            WHERE e.source_type = 'cod_collection' AND e.source_id = c.id::text)
        ORDER BY c.recorded_at`;
      const fees = await tx.$queryRaw<
        {
          id: string;
          tracking_number: string;
          merchant_id: string;
          fee: string;
          delivered_at: Date | null;
        }[]
      >`
        SELECT s.id, s.tracking_number, s.merchant_id, s.delivery_fee::text AS fee, s.delivered_at
        FROM shipments s
        WHERE s.status = 'DELIVERED' AND s.delivery_fee > 0
          AND NOT EXISTS (
            SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.shipment_id = s.id
              AND e.kind IN ('DELIVERY_FEE', 'FEE_ADJUSTMENT', 'PHASE2_BACKFILL'))
        ORDER BY s.delivered_at`;

      if (execute) {
        for (const c of collections) {
          await ledger.post(tx, {
            kind: 'PHASE2_BACKFILL',
            sourceType: 'cod_collection',
            sourceId: c.id,
            createdById: null,
            description: `Phase 2 COD ${c.tracking_number}`,
            lines: [
              debit(accounts.driverCustody(c.driver_id), c.amount),
              credit(accounts.merchantPending(c.merchant_id), c.amount),
            ],
          });
        }
        for (const f of fees) {
          await ledger.post(tx, {
            kind: 'PHASE2_BACKFILL',
            sourceType: 'shipment_fee',
            sourceId: f.id,
            createdById: null,
            description: `Phase 2 delivery fee ${f.tracking_number}`,
            lines: [
              debit(accounts.merchantBalance(f.merchant_id), f.fee, f.id),
              credit(accounts.deliveryFeeRevenue(), f.fee, f.id),
            ],
          });
        }
      }

      const sum = (values: string[]) =>
        values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0)).toFixed(2);
      return {
        executed: execute,
        collections: collections.map((c) => ({
          id: c.id,
          trackingNumber: c.tracking_number,
          driverId: c.driver_id,
          merchantId: c.merchant_id,
          amount: new Prisma.Decimal(c.amount).toFixed(2),
          recordedAt: c.recorded_at.toISOString(),
        })),
        fees: fees.map((f) => ({
          shipmentId: f.id,
          trackingNumber: f.tracking_number,
          merchantId: f.merchant_id,
          fee: new Prisma.Decimal(f.fee).toFixed(2),
          deliveredAt: f.delivered_at?.toISOString() ?? null,
        })),
        totals: {
          collections: sum(collections.map((c) => c.amount)),
          fees: sum(fees.map((f) => f.fee)),
        },
      };
    },
    { timeout: 120_000 },
  );
}
