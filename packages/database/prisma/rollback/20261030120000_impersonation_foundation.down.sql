-- Rollback for migration 20261030120000_impersonation_foundation (ADR 0003 §7). NOT a Prisma
-- migration: Prisma never runs files in this folder. Run it by hand, in one transaction, only
-- after the API version that uses impersonation has been withdrawn:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 20261030120000_impersonation_foundation.down.sql
--
-- It restores the schema of migration 13 exactly and leaves every pre-existing row untouched.
-- It refuses to run once any impersonation has been recorded, because it would then delete
-- audit attribution; after go-live, fix forward instead. To discard test data deliberately:
--   SET coobra.allow_impersonation_data_loss = 'yes';   (in the same session, before running)

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "impersonation_sessions")
     AND current_setting('coobra.allow_impersonation_data_loss', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Impersonations are recorded; rolling back would delete audit attribution. Fix forward instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM "financial_adjustments" WHERE "source_type" <> 'UNLINKED')
     AND current_setting('coobra.allow_impersonation_data_loss', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Adjustments record their provenance; rolling back would delete it. Fix forward instead.';
  END IF;
END $$;

-- Triggers and their functions.
DROP TRIGGER IF EXISTS "financial_adjustments_provenance_check" ON "financial_adjustments";
DROP TRIGGER IF EXISTS "financial_adjustments_provenance_immutable" ON "financial_adjustments";
DROP FUNCTION IF EXISTS coobra_adjustment_provenance_check();
DROP FUNCTION IF EXISTS coobra_adjustment_provenance_guard();
DROP TRIGGER IF EXISTS "audit_logs_attribution_immutable" ON "audit_logs";
DROP TRIGGER IF EXISTS "shipment_status_history_attribution_immutable" ON "shipment_status_history";
DROP TRIGGER IF EXISTS "shipments_attribution_immutable" ON "shipments";
DROP TRIGGER IF EXISTS "return_records_attribution_immutable" ON "return_records";
DROP TRIGGER IF EXISTS "pricing_quotes_attribution_immutable" ON "pricing_quotes";
DROP TRIGGER IF EXISTS "sessions_attribution_immutable" ON "sessions";
DROP TRIGGER IF EXISTS "impersonation_sessions_people_check" ON "impersonation_sessions";
DROP TRIGGER IF EXISTS "impersonation_sessions_immutable" ON "impersonation_sessions";
DROP TRIGGER IF EXISTS "impersonation_exchange_codes_immutable" ON "impersonation_exchange_codes";
DROP FUNCTION IF EXISTS coobra_impersonation_attribution_guard();
DROP FUNCTION IF EXISTS coobra_impersonation_people_check();
DROP FUNCTION IF EXISTS coobra_impersonation_session_guard();
DROP FUNCTION IF EXISTS coobra_impersonation_code_guard();

-- Constraints added to existing tables.
ALTER TABLE "financial_adjustments" DROP CONSTRAINT IF EXISTS "financial_adjustments_source_check";
ALTER TABLE "financial_adjustments" DROP CONSTRAINT IF EXISTS "financial_adjustments_source_shipment_id_fkey";
ALTER TABLE "financial_adjustments" DROP CONSTRAINT IF EXISTS "financial_adjustments_source_journal_entry_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_impersonation_id_user_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_impersonation_check";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_impersonation_id_actor_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_impersonation_id_effective_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_impersonation_check";
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_created_impersonation_id_created_by_id_fkey";
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_created_impersonation_id_merchant_id_fkey";
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_created_impersonation_check";
ALTER TABLE "shipment_status_history" DROP CONSTRAINT IF EXISTS "shipment_status_history_impersonation_id_actor_user_id_fkey";
ALTER TABLE "shipment_status_history" DROP CONSTRAINT IF EXISTS "shipment_status_history_impersonation_check";
ALTER TABLE "return_records" DROP CONSTRAINT IF EXISTS "return_records_requested_impersonation_id_requested_by_id_fkey";
ALTER TABLE "return_records" DROP CONSTRAINT IF EXISTS "return_records_requested_impersonation_check";
ALTER TABLE "pricing_quotes" DROP CONSTRAINT IF EXISTS "pricing_quotes_impersonation_id_created_by_id_fkey";
ALTER TABLE "pricing_quotes" DROP CONSTRAINT IF EXISTS "pricing_quotes_impersonation_id_merchant_id_fkey";

-- Indexes on existing tables.
DROP INDEX IF EXISTS "audit_logs_impersonation_id_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_effective_user_id_created_at_idx";
DROP INDEX IF EXISTS "return_records_requested_impersonation_id_idx";
DROP INDEX IF EXISTS "sessions_impersonation_id_key";
DROP INDEX IF EXISTS "shipment_status_history_impersonation_id_idx";
DROP INDEX IF EXISTS "shipments_created_impersonation_id_idx";
DROP INDEX IF EXISTS "pricing_quotes_impersonation_id_idx";
DROP INDEX IF EXISTS "financial_adjustments_source_shipment_id_idx";
DROP INDEX IF EXISTS "financial_adjustments_source_journal_entry_id_idx";

-- Columns added to existing tables (all NULL unless impersonation was used).
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "effective_user_id", DROP COLUMN IF EXISTS "impersonation_id";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "impersonation_id", DROP COLUMN IF EXISTS "reauthenticated_at";
ALTER TABLE "shipment_status_history" DROP COLUMN IF EXISTS "impersonation_id";
ALTER TABLE "shipments" DROP COLUMN IF EXISTS "created_impersonation_id";
ALTER TABLE "return_records" DROP COLUMN IF EXISTS "requested_impersonation_id";
ALTER TABLE "pricing_quotes" DROP COLUMN IF EXISTS "impersonation_id";
ALTER TABLE "financial_adjustments" DROP COLUMN IF EXISTS "source_type", DROP COLUMN IF EXISTS "source_shipment_id", DROP COLUMN IF EXISTS "source_journal_entry_id";

-- New tables and types.
DROP TABLE IF EXISTS "notification_outbox";
DROP TABLE IF EXISTS "impersonation_exchange_codes";
DROP TABLE IF EXISTS "impersonation_sessions";
DROP TYPE IF EXISTS "NotificationStatus";
DROP TYPE IF EXISTS "NotificationKind";
DROP TYPE IF EXISTS "ImpersonationEndReason";
DROP TYPE IF EXISTS "AdjustmentSourceType";

-- Let Prisma apply the migration again later.
DO $$
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030120000_impersonation_foundation';
  END IF;
END $$;
