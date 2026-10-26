-- Phase 3 (E): merchant payouts (separation of duties), merchant payments and
-- treasury transfers. Additive only.

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'E_WALLET', 'CHEQUE');

-- CreateTable
CREATE TABLE "merchant_payouts" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_merchant" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "paid_by_id" UUID,
    "paid_at" TIMESTAMP(3),
    "reference" TEXT,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_payments" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "channel" "CashChannel" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_transfers" (
    "id" UUID NOT NULL,
    "from_channel" "CashChannel" NOT NULL,
    "to_channel" "CashChannel" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payouts_journal_entry_id_key" ON "merchant_payouts"("journal_entry_id");

-- CreateIndex
CREATE INDEX "merchant_payouts_merchant_id_status_idx" ON "merchant_payouts"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_payouts_status_created_at_idx" ON "merchant_payouts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payouts_method_reference_key" ON "merchant_payouts"("method", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payments_journal_entry_id_key" ON "merchant_payments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "merchant_payments_merchant_id_idx" ON "merchant_payments"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_transfers_journal_entry_id_key" ON "treasury_transfers"("journal_entry_id");

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payments" ADD CONSTRAINT "merchant_payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payments" ADD CONSTRAINT "merchant_payments_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_amount_positive" CHECK ("amount" > 0);
-- The approver is never the creator (also enforced by the API).
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_separation_of_duties"
  CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "created_by_id");
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_paid_has_reference"
  CHECK ("status" <> 'PAID' OR ("reference" IS NOT NULL AND "journal_entry_id" IS NOT NULL AND "approved_by_id" IS NOT NULL));
ALTER TABLE "merchant_payments" ADD CONSTRAINT "merchant_payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_distinct_channels" CHECK ("from_channel" <> "to_channel");
