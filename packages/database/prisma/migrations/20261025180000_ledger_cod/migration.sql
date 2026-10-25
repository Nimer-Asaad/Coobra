-- Phase 3 (C): double-entry ledger, COD collection progress, recipient shortfalls,
-- manual adjustments, finance settings and idempotency records.
-- Additive: new tables; new columns with defaults on shipments and cod_collections.
-- No ledger postings are created here (Phase 2 backfill is a separate, approved step).

-- CreateEnum
CREATE TYPE "CodStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PARTIAL', 'COLLECTED', 'SHORTFALL_RESOLVED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountPurpose" AS ENUM ('COMPANY_CASH_HUB', 'COMPANY_BANK', 'COMPANY_EWALLET', 'DRIVER_CUSTODY', 'DRIVER_RECEIVABLE', 'MERCHANT_COD_PENDING', 'MERCHANT_BALANCE', 'DELIVERY_FEE_REVENUE', 'RETURN_FEE_REVENUE', 'COD_SHORTFALL_EXPENSE', 'DRIVER_CASH_LOSS_EXPENSE', 'ADJUSTMENT_EXPENSE');

-- CreateEnum
CREATE TYPE "JournalKind" AS ENUM ('COD_COLLECTION', 'DELIVERY_FEE', 'RETURN_FEE', 'FEE_ADJUSTMENT', 'DRIVER_SETTLEMENT', 'DRIVER_CASH_SHORTAGE', 'DRIVER_REPAYMENT', 'COD_SHORTFALL', 'MERCHANT_PAYOUT', 'MERCHANT_PAYMENT', 'TREASURY_TRANSFER', 'MERCHANT_ADJUSTMENT', 'REVERSAL', 'PHASE2_BACKFILL');

-- CreateEnum
CREATE TYPE "EntrySide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "ShortfallStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'AWAITING_MERCHANT', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ShortfallResolution" AS ENUM ('COLLECTED', 'COMPANY_ABSORBS', 'DRIVER_RESPONSIBLE', 'MERCHANT_ACCEPTS');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('MERCHANT_CREDIT', 'MERCHANT_DEBIT');

-- AlterTable
ALTER TABLE "cod_collections" ADD COLUMN     "cleared_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "cod_collected_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cod_status" "CodStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" "AccountPurpose" NOT NULL,
    "type" "AccountType" NOT NULL,
    "owner_user_id" UUID,
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "kind" "JournalKind" NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "reversal_of_id" UUID,
    "description" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "side" "EntrySide" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "shipment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_shortfalls" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "expected_amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ShortfallStatus" NOT NULL DEFAULT 'OPEN',
    "proposed_resolution" "ShortfallResolution",
    "proposed_amount" DECIMAL(12,2),
    "proposal_note" TEXT,
    "proposed_by_id" UUID,
    "proposed_at" TIMESTAMP(3),
    "resolution" "ShortfallResolution",
    "resolved_amount" DECIMAL(12,2),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "merchant_accepted_at" TIMESTAMP(3),
    "journal_entry_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cod_shortfalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_adjustments" (
    "id" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "merchant_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "finance_setting_changes" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_setting_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_code_key" ON "financial_accounts"("code");

-- CreateIndex
CREATE INDEX "financial_accounts_purpose_idx" ON "financial_accounts"("purpose");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversal_of_id_key" ON "journal_entries"("reversal_of_id");

-- CreateIndex
CREATE INDEX "journal_entries_created_at_idx" ON "journal_entries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_kind_source_type_source_id_key" ON "journal_entries"("kind", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_created_at_idx" ON "journal_lines"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_shipment_id_idx" ON "journal_lines"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "cod_shortfalls_shipment_id_key" ON "cod_shortfalls"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "cod_shortfalls_journal_entry_id_key" ON "cod_shortfalls"("journal_entry_id");

-- CreateIndex
CREATE INDEX "cod_shortfalls_status_idx" ON "cod_shortfalls"("status");

-- CreateIndex
CREATE INDEX "cod_shortfalls_merchant_id_status_idx" ON "cod_shortfalls"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "financial_adjustments_journal_entry_id_key" ON "financial_adjustments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "financial_adjustments_status_idx" ON "financial_adjustments"("status");

-- CreateIndex
CREATE INDEX "finance_setting_changes_key_created_at_idx" ON "finance_setting_changes"("key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_key_key" ON "idempotency_records"("user_id", "scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "cod_collections_idempotency_key_key" ON "cod_collections"("idempotency_key");

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_setting_changes" ADD CONSTRAINT "finance_setting_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Amount sanity.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_cleared_within_amount"
  CHECK ("cleared_amount" >= 0 AND "cleared_amount" <= "collected_amount");
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cod_collected_within_amount"
  CHECK ("cod_collected_amount" >= 0 AND "cod_collected_amount" <= "cod_amount");
ALTER TABLE "cod_shortfalls" ADD CONSTRAINT "cod_shortfalls_amounts_non_negative"
  CHECK ("expected_amount" > 0 AND ("proposed_amount" IS NULL OR "proposed_amount" > 0) AND ("resolved_amount" IS NULL OR "resolved_amount" >= 0));
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_owner_matches_purpose"
  CHECK (("purpose" IN ('DRIVER_CUSTODY', 'DRIVER_RECEIVABLE', 'MERCHANT_COD_PENDING', 'MERCHANT_BALANCE')) = ("owner_user_id" IS NOT NULL));

-- The ledger is append-only: posted history can never be edited or deleted.
CREATE FUNCTION coobra_ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger table % is append-only; post a reversal instead', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION coobra_ledger_is_append_only();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION coobra_ledger_is_append_only();

-- Every entry must balance (debits = credits) with at least two lines, checked at commit.
CREATE FUNCTION coobra_check_journal_entry(entry uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  debits numeric;
  credits numeric;
  line_count integer;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN side = 'DEBIT' THEN amount END), 0),
         COALESCE(SUM(CASE WHEN side = 'CREDIT' THEN amount END), 0),
         COUNT(*)
    INTO debits, credits, line_count
    FROM journal_lines WHERE entry_id = entry;
  IF line_count < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debits %, credits %, lines %)', entry, debits, credits, line_count
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
CREATE FUNCTION coobra_journal_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM coobra_check_journal_entry(NEW.entry_id);
  RETURN NULL;
END;
$$;
CREATE FUNCTION coobra_journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM coobra_check_journal_entry(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION coobra_journal_line_balanced();
CREATE CONSTRAINT TRIGGER journal_entries_have_lines AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION coobra_journal_entry_balanced();

-- Existing shipments: derive COD progress from their Phase 2 collection records (no postings).
UPDATE "shipments" s SET "cod_collected_amount" = c.total
FROM (SELECT shipment_id, SUM(collected_amount) AS total FROM cod_collections GROUP BY shipment_id) c
WHERE c.shipment_id = s.id;
UPDATE "shipments" SET "cod_status" = CASE
  WHEN "cod_amount" = 0 THEN 'NOT_REQUIRED'::"CodStatus"
  WHEN "cod_collected_amount" >= "cod_amount" THEN 'COLLECTED'::"CodStatus"
  ELSE 'PENDING'::"CodStatus" END;

-- Initial approval threshold (ILS); changed only by SUPER_ADMIN, with history.
INSERT INTO "finance_settings" ("key", "value") VALUES ('APPROVAL_THRESHOLD', '200.00');
