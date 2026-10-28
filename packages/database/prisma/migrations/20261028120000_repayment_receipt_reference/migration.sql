-- Receipt / transfer reference for driver debt repayments (additive). Existing repayments keep
-- NULL (they predate references); PostgreSQL unique indexes treat NULLs as distinct, so they
-- never conflict. New repayments must carry a reference (enforced by the API), and the same
-- reference can be used only once per cash channel, so one real payment cannot be posted twice.
ALTER TABLE "driver_repayments" ADD COLUMN "receipt_reference" TEXT;

CREATE UNIQUE INDEX "driver_repayments_channel_receipt_reference_key"
  ON "driver_repayments"("channel", "receipt_reference");
