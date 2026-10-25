-- Phase 3 (F2): return records (request, approval, return driver, return fee decision).
-- Additive only; existing returned shipments are left as they are.

-- CreateEnum
CREATE TYPE "ReturnFeeStatus" AS ENUM ('RETURN_FEE_UNCONFIGURED', 'SET', 'WAIVED', 'POSTED');

-- CreateTable
CREATE TABLE "return_records" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "request_reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "return_driver_id" UUID,
    "original_driver_id" UUID,
    "fee_status" "ReturnFeeStatus" NOT NULL,
    "fee_amount" DECIMAL(12,2),
    "fee_set_by_id" UUID,
    "fee_set_at" TIMESTAMP(3),
    "fee_reason" TEXT,
    "journal_entry_id" UUID,
    "completed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_records_shipment_id_key" ON "return_records"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_records_journal_entry_id_key" ON "return_records"("journal_entry_id");

-- CreateIndex
CREATE INDEX "return_records_fee_status_idx" ON "return_records"("fee_status");

-- CreateIndex
CREATE INDEX "return_records_closed_at_idx" ON "return_records"("closed_at");

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_return_driver_id_fkey" FOREIGN KEY ("return_driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_fee_set_by_id_fkey" FOREIGN KEY ("fee_set_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "return_records" ADD CONSTRAINT "return_records_fee_consistent"
  CHECK ((fee_status = 'RETURN_FEE_UNCONFIGURED' AND fee_amount IS NULL)
      OR (fee_status = 'WAIVED' AND fee_amount = 0 AND fee_reason IS NOT NULL)
      OR (fee_status IN ('SET', 'POSTED') AND fee_amount IS NOT NULL AND fee_amount >= 0));
