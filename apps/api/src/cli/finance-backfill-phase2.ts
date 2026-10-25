/**
 * Phase 2 finance backfill. Phase 2 recorded COD collections and delivery fees before the
 * ledger existed. This posts them as PHASE2_BACKFILL entries so balances include them.
 *
 *   pnpm finance:backfill-phase2            # dry run: prints what would be posted, writes nothing
 *   pnpm finance:backfill-phase2 --execute  # posts (only after the owner approved the dry run)
 *
 * Idempotent: anything that already has a ledger entry is skipped, so it never double counts.
 */
import { createPrismaClient } from '@coobra/database';
import { loadRootEnvFile } from '../config/load-env-file.js';
import { runPhase2Backfill } from '../finance/phase2-backfill.js';

async function main(): Promise<void> {
  loadRootEnvFile();
  const execute = process.argv.includes('--execute');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = createPrismaClient({ connectionString: url });
  try {
    const report = await runPhase2Backfill(prisma, { execute });
    const mode = execute ? 'EXECUTED' : 'DRY RUN (nothing was written)';
    console.log(`\nCOOBRA Phase 2 finance backfill - ${mode}`);
    console.log(
      `\n1) COD collections without a ledger entry: ${report.collections.length}` +
        ` (total ${report.totals.collections} ILS)`,
    );
    for (const c of report.collections) {
      console.log(`   ${c.trackingNumber}  ${c.amount} ILS  collected ${c.recordedAt}`);
      console.log(`      DEBIT  DRIVER_CUSTODY:${c.driverId}  ${c.amount}`);
      console.log(`      CREDIT MERCHANT_COD_PENDING:${c.merchantId}  ${c.amount}`);
    }
    console.log(
      `\n2) Delivered shipments whose fee was never posted: ${report.fees.length}` +
        ` (total ${report.totals.fees} ILS)`,
    );
    for (const f of report.fees) {
      console.log(`   ${f.trackingNumber}  fee ${f.fee} ILS  delivered ${f.deliveredAt ?? '-'}`);
      console.log(`      DEBIT  MERCHANT_BALANCE:${f.merchantId}  ${f.fee}`);
      console.log(`      CREDIT DELIVERY_FEE_REVENUE  ${f.fee}`);
    }
    console.log(
      '\nEffect: drivers hold this cash in custody until a settlement is confirmed, and' +
        '\nmerchants are charged these fees. If a driver already handed this cash over in' +
        '\nPhase 2, record a driver settlement for it after the backfill.',
    );
    console.log(execute ? '\nDone.\n' : '\nDry run only. Re-run with --execute after approval.\n');
  } finally {
    await prisma.$disconnect();
  }
}

await main();
