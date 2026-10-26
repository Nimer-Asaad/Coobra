-- Phase 3 (D): driver settlements (partial allowed), driver cash shortages, cash clearings
-- and driver repayments. Additive only.

-- CreateEnum
CREATE TYPE "CashChannel" AS ENUM ('HUB', 'BANK', 'EWALLET');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DriverShortageResponsibility" AS ENUM ('DRIVER_LIABLE', 'COMPANY_ABSORBS');

-- CreateTable
CREATE TABLE "driver_settlements" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'SUBMITTED',
    "declared_amount" DECIMAL(12,2) NOT NULL,
    "counted_amount" DECIMAL(12,2),
    "channel" "CashChannel" NOT NULL DEFAULT 'HUB',
    "note" TEXT,
    "submitted_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_cash_shortages" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "responsibility" "DriverShortageResponsibility" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "proposed_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_cash_shortages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_clearings" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "settlement_id" UUID,
    "driver_shortage_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_clearings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_repayments" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "channel" "CashChannel" NOT NULL DEFAULT 'HUB',
    "note" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_settlements_journal_entry_id_key" ON "driver_settlements"("journal_entry_id");

-- CreateIndex
CREATE INDEX "driver_settlements_driver_id_status_idx" ON "driver_settlements"("driver_id", "status");

-- CreateIndex
CREATE INDEX "driver_settlements_status_created_at_idx" ON "driver_settlements"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_cash_shortages_journal_entry_id_key" ON "driver_cash_shortages"("journal_entry_id");

-- CreateIndex
CREATE INDEX "driver_cash_shortages_driver_id_status_idx" ON "driver_cash_shortages"("driver_id", "status");

-- CreateIndex
CREATE INDEX "cash_clearings_collection_id_idx" ON "cash_clearings"("collection_id");

-- CreateIndex
CREATE INDEX "cash_clearings_settlement_id_idx" ON "cash_clearings"("settlement_id");

-- CreateIndex
CREATE INDEX "cash_clearings_driver_shortage_id_idx" ON "cash_clearings"("driver_shortage_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_repayments_journal_entry_id_key" ON "driver_repayments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "driver_repayments_driver_id_idx" ON "driver_repayments"("driver_id");

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_cash_shortages" ADD CONSTRAINT "driver_cash_shortages_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_cash_shortages" ADD CONSTRAINT "driver_cash_shortages_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_cash_shortages" ADD CONSTRAINT "driver_cash_shortages_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_clearings" ADD CONSTRAINT "cash_clearings_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "cod_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_clearings" ADD CONSTRAINT "cash_clearings_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_clearings" ADD CONSTRAINT "cash_clearings_driver_shortage_id_fkey" FOREIGN KEY ("driver_shortage_id") REFERENCES "driver_cash_shortages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_repayments" ADD CONSTRAINT "driver_repayments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_repayments" ADD CONSTRAINT "driver_repayments_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_amounts_positive"
  CHECK ("declared_amount" > 0 AND ("counted_amount" IS NULL OR ("counted_amount" > 0 AND "counted_amount" <= "declared_amount")));
ALTER TABLE "driver_cash_shortages" ADD CONSTRAINT "driver_cash_shortages_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "driver_repayments" ADD CONSTRAINT "driver_repayments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "cash_clearings" ADD CONSTRAINT "cash_clearings_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "cash_clearings" ADD CONSTRAINT "cash_clearings_single_source"
  CHECK (("settlement_id" IS NOT NULL) <> ("driver_shortage_id" IS NOT NULL));
