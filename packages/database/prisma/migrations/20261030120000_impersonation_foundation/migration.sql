-- Phase 4C.1 — impersonation foundation (ADR 0003). Additive only: three new tables, new
-- nullable or constant-default columns on existing tables, indexes, foreign keys, CHECK
-- constraints and guard triggers. No existing column, row or constraint is changed or removed.
-- The ledger (journal_entries, journal_lines) gains no column and no row changes; the only
-- money table with new columns is financial_adjustments (its provenance). The application does
-- not use any of this until impersonation is enabled.

-- Fail fast instead of queueing live traffic behind this migration: give up if a lock is not
-- granted within 5 seconds (nothing is applied; re-run when the database is quieter, ADR §7).
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ImpersonationEndReason" AS ENUM ('MANUAL', 'EXPIRED', 'ACTOR_LOGOUT', 'ACTOR_SESSION_ENDED', 'ACTOR_REVOKED', 'TARGET_REVOKED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('IMPERSONATION_SUMMARY');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "effective_user_id" UUID,
ADD COLUMN     "impersonation_id" UUID;

-- AlterTable
ALTER TABLE "return_records" ADD COLUMN     "requested_impersonation_id" UUID;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "impersonation_id" UUID,
ADD COLUMN     "reauthenticated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "shipment_status_history" ADD COLUMN     "impersonation_id" UUID;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "created_impersonation_id" UUID;

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_session_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "target_role" "UserRole" NOT NULL,
    "client_app" "ClientApp" NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket_reference" TEXT,
    "active_actor_id" UUID,
    "active_target_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_reason" "ImpersonationEndReason",
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_exchange_codes" (
    "id" UUID NOT NULL,
    "impersonation_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impersonation_exchange_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "impersonation_id" UUID,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_active_actor_id_key" ON "impersonation_sessions"("active_actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_active_target_id_key" ON "impersonation_sessions"("active_target_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_actor_user_id_started_at_idx" ON "impersonation_sessions"("actor_user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "impersonation_sessions_target_user_id_started_at_idx" ON "impersonation_sessions"("target_user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "impersonation_sessions_actor_session_id_idx" ON "impersonation_sessions"("actor_session_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_ended_at_expires_at_idx" ON "impersonation_sessions"("ended_at", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_id_actor_user_id_key" ON "impersonation_sessions"("id", "actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_id_target_user_id_key" ON "impersonation_sessions"("id", "target_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_exchange_codes_impersonation_id_key" ON "impersonation_exchange_codes"("impersonation_id");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_exchange_codes_code_hash_key" ON "impersonation_exchange_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_outbox_impersonation_id_idx" ON "notification_outbox"("impersonation_id");

-- CreateIndex
CREATE INDEX "audit_logs_impersonation_id_created_at_idx" ON "audit_logs"("impersonation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_effective_user_id_created_at_idx" ON "audit_logs"("effective_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "return_records_requested_impersonation_id_idx" ON "return_records"("requested_impersonation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_impersonation_id_key" ON "sessions"("impersonation_id");

-- CreateIndex
CREATE INDEX "shipment_status_history_impersonation_id_idx" ON "shipment_status_history"("impersonation_id");

-- CreateIndex
CREATE INDEX "shipments_created_impersonation_id_idx" ON "shipments"("created_impersonation_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonation_id_user_id_fkey" FOREIGN KEY ("impersonation_id", "user_id") REFERENCES "impersonation_sessions"("id", "target_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_impersonation_id_actor_user_id_fkey" FOREIGN KEY ("impersonation_id", "actor_user_id") REFERENCES "impersonation_sessions"("id", "actor_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_impersonation_id_effective_user_id_fkey" FOREIGN KEY ("impersonation_id", "effective_user_id") REFERENCES "impersonation_sessions"("id", "target_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_impersonation_id_created_by_id_fkey" FOREIGN KEY ("created_impersonation_id", "created_by_id") REFERENCES "impersonation_sessions"("id", "actor_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_impersonation_id_merchant_id_fkey" FOREIGN KEY ("created_impersonation_id", "merchant_id") REFERENCES "impersonation_sessions"("id", "target_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_impersonation_id_actor_user_id_fkey" FOREIGN KEY ("impersonation_id", "actor_user_id") REFERENCES "impersonation_sessions"("id", "actor_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_requested_impersonation_id_requested_by_id_fkey" FOREIGN KEY ("requested_impersonation_id", "requested_by_id") REFERENCES "impersonation_sessions"("id", "actor_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_actor_session_id_fkey" FOREIGN KEY ("actor_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "impersonation_exchange_codes" ADD CONSTRAINT "impersonation_exchange_codes_impersonation_id_fkey" FOREIGN KEY ("impersonation_id") REFERENCES "impersonation_sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_impersonation_id_fkey" FOREIGN KEY ("impersonation_id") REFERENCES "impersonation_sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable
ALTER TABLE "pricing_quotes" ADD COLUMN     "impersonation_id" UUID;

-- CreateIndex
CREATE INDEX "pricing_quotes_impersonation_id_idx" ON "pricing_quotes"("impersonation_id");

-- AddForeignKey
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_impersonation_id_created_by_id_fkey" FOREIGN KEY ("impersonation_id", "created_by_id") REFERENCES "impersonation_sessions"("id", "actor_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_impersonation_id_merchant_id_fkey" FOREIGN KEY ("impersonation_id", "merchant_id") REFERENCES "impersonation_sessions"("id", "target_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateEnum
CREATE TYPE "AdjustmentSourceType" AS ENUM ('SHIPMENT_FEE', 'RETURN_CHARGE', 'COD_SHORTFALL', 'JOURNAL_ENTRY', 'UNLINKED');

-- AlterTable (a constant default: existing rows are not rewritten and read as UNLINKED)
ALTER TABLE "financial_adjustments" ADD COLUMN     "source_journal_entry_id" UUID,
ADD COLUMN     "source_shipment_id" UUID,
ADD COLUMN     "source_type" "AdjustmentSourceType" NOT NULL DEFAULT 'UNLINKED';

-- CreateIndex
CREATE INDEX "financial_adjustments_source_shipment_id_idx" ON "financial_adjustments"("source_shipment_id");

-- CreateIndex
CREATE INDEX "financial_adjustments_source_journal_entry_id_idx" ON "financial_adjustments"("source_journal_entry_id");

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_source_shipment_id_fkey" FOREIGN KEY ("source_shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_source_journal_entry_id_fkey" FOREIGN KEY ("source_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------
-- Integrity rules Prisma does not model (CHECK constraints). Prisma Migrate does not introspect
-- CHECK constraints, so they cause no schema drift.
-- ---------------------------------------------------------------------------------------------

-- At most one active impersonation per actor and per target: an active row holds both slots
-- (unique columns) and an ended row holds neither. IS NOT DISTINCT FROM (never NULL) matters: a
-- CHECK passes when it evaluates to NULL, so `active_actor_id = actor_user_id` would let an
-- active row with a NULL slot escape the unique index.
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_active_slots_check" CHECK (
  ("ended_at" IS NULL
    AND "active_actor_id" IS NOT DISTINCT FROM "actor_user_id"
    AND "active_target_id" IS NOT DISTINCT FROM "target_user_id")
  OR ("ended_at" IS NOT NULL AND "active_actor_id" IS NULL AND "active_target_id" IS NULL)
);
-- Only merchant and driver accounts, each in its own app; never yourself.
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_check" CHECK (
  ("target_role" = 'MERCHANT' AND "client_app" = 'MERCHANT_APP')
  OR ("target_role" = 'DRIVER' AND "client_app" = 'DRIVER_APP')
);
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_not_self_check" CHECK ("actor_user_id" <> "target_user_id");
-- 30 minutes at most, never extended.
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_duration_check" CHECK (
  "expires_at" > "started_at" AND "expires_at" <= "started_at" + INTERVAL '30 minutes'
);
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_end_check" CHECK (
  ("ended_at" IS NULL) = ("ended_reason" IS NULL) AND ("ended_at" IS NULL OR "ended_at" >= "started_at")
);
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_reason_check" CHECK (
  char_length(btrim("reason")) BETWEEN 1 AND 500
  AND ("ticket_reference" IS NULL OR char_length(btrim("ticket_reference")) BETWEEN 1 AND 100)
);

-- Exchange codes: SHA-256 hex hash, base64url SHA-256 challenge, valid 60 seconds at most.
ALTER TABLE "impersonation_exchange_codes" ADD CONSTRAINT "impersonation_exchange_codes_format_check" CHECK (
  "code_hash" ~ '^[0-9a-f]{64}$' AND "code_challenge" ~ '^[A-Za-z0-9_-]{43}$'
);
ALTER TABLE "impersonation_exchange_codes" ADD CONSTRAINT "impersonation_exchange_codes_ttl_check" CHECK (
  "expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '60 seconds'
  AND ("used_at" IS NULL OR "used_at" >= "created_at")
);

-- Temporary sessions belong to the target's app and never carry a step-up.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonation_check" CHECK (
  "impersonation_id" IS NULL OR ("client_app" <> 'ADMIN_WEB' AND "reauthenticated_at" IS NULL)
);

-- Attribution. The composite foreign keys above tie the actor and the effective account to the
-- impersonation, but a composite key is not checked when any of its columns is NULL (MATCH
-- SIMPLE). These checks make the actor mandatory whenever an impersonation is recorded.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_impersonation_check" CHECK (
  ("effective_user_id" IS NULL) = ("impersonation_id" IS NULL)
  AND ("impersonation_id" IS NULL OR "actor_user_id" IS NOT NULL)
);
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_impersonation_check" CHECK (
  "impersonation_id" IS NULL OR "actor_user_id" IS NOT NULL
);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_impersonation_check" CHECK (
  "created_impersonation_id" IS NULL OR "created_by_id" IS NOT NULL
);
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_requested_impersonation_check" CHECK (
  "requested_impersonation_id" IS NULL OR "requested_by_id" IS NOT NULL
);

-- Outbox: idempotent (unique dedupe key), leased by one sender at a time, SENT exactly when sent.
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_state_check" CHECK (
  ("status" = 'SENT') = ("sent_at" IS NOT NULL)
  AND ("lease_token" IS NULL) = ("lease_expires_at" IS NULL)
  AND "attempts" >= 0
  AND char_length(btrim("dedupe_key")) BETWEEN 1 AND 200
  AND ("last_error" IS NULL OR char_length("last_error") <= 500)
);
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_kind_check" CHECK (
  "kind" <> 'IMPERSONATION_SUMMARY' OR "impersonation_id" IS NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Triggers. Foreign keys protect an impersonation from its parent side only; these rules make the
-- attribution written on each record permanent, so the conflict-of-interest rule (ADR 0003 R1)
-- can rely on it after the impersonation has ended. Like the ledger triggers, they do not fire on
-- TRUNCATE. Each UPDATE trigger fires only when one of its columns is in the SET list, and none
-- applies to a row written outside impersonation (all their columns are NULL there).
-- ---------------------------------------------------------------------------------------------

-- The people an impersonation names must be what the row says, when it is created: an active
-- SUPER_ADMIN starting from their own unrevoked admin session (never an impersonation session),
-- and an active target whose real role is the recorded one.
CREATE FUNCTION coobra_impersonation_people_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_row record;
  target_row record;
  session_row record;
BEGIN
  SELECT role, status INTO actor_row FROM "users" WHERE id = NEW.actor_user_id;
  IF actor_row.role IS DISTINCT FROM 'SUPER_ADMIN' OR actor_row.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'impersonation_sessions_people_check: the actor must be an active SUPER_ADMIN'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT role, status INTO target_row FROM "users" WHERE id = NEW.target_user_id;
  IF target_row.role IS DISTINCT FROM NEW.target_role OR target_row.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'impersonation_sessions_people_check: the target must be active and have the recorded role'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT user_id, client_app, impersonation_id, revoked_at INTO session_row
    FROM "sessions" WHERE id = NEW.actor_session_id;
  IF session_row.user_id IS DISTINCT FROM NEW.actor_user_id
     OR session_row.client_app IS DISTINCT FROM 'ADMIN_WEB'
     OR session_row.impersonation_id IS NOT NULL
     OR session_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'impersonation_sessions_people_check: it must start from the actor''s own active admin session'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER impersonation_sessions_people_check BEFORE INSERT ON "impersonation_sessions"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_people_check();

-- An impersonation is permanent history: it can be ended once (end time, reason, slots released)
-- and nothing else about it ever changes. This also stops extending it by moving started_at.
CREATE FUNCTION coobra_impersonation_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'impersonation_sessions_immutable: impersonation % cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'impersonation_sessions_immutable: impersonation % has ended and cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.actor_user_id, NEW.actor_session_id, NEW.target_user_id, NEW.target_role,
      NEW.client_app, NEW.reason, NEW.ticket_reference, NEW.started_at, NEW.expires_at,
      NEW.ip_address, NEW.user_agent)
     IS DISTINCT FROM
     (OLD.id, OLD.actor_user_id, OLD.actor_session_id, OLD.target_user_id, OLD.target_role,
      OLD.client_app, OLD.reason, OLD.ticket_reference, OLD.started_at, OLD.expires_at,
      OLD.ip_address, OLD.user_agent) THEN
    RAISE EXCEPTION 'impersonation_sessions_immutable: only the end of impersonation % can be recorded', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER impersonation_sessions_immutable BEFORE UPDATE OR DELETE ON "impersonation_sessions"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_session_guard();

-- An exchange code can only be marked used, once; it is never deleted.
CREATE FUNCTION coobra_impersonation_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.used_at IS NOT NULL
     OR (NEW.id, NEW.impersonation_id, NEW.code_hash, NEW.code_challenge, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.impersonation_id, OLD.code_hash, OLD.code_challenge, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'impersonation_exchange_codes_immutable: a code can only be redeemed, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER impersonation_exchange_codes_immutable BEFORE UPDATE OR DELETE ON "impersonation_exchange_codes"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_code_guard();

-- Attribution on records written during an impersonation is permanent. TG_ARGV[0] is the
-- impersonation column; the other arguments are the columns frozen once it is set. The
-- impersonation column itself can never change after the row is written (not set later, not
-- cleared, not moved to another impersonation), and such a row cannot be deleted.
CREATE FUNCTION coobra_impersonation_attribution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb;
  column_name text;
  i integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF old_row ->> TG_ARGV[0] IS NOT NULL THEN
      RAISE EXCEPTION '%_attribution_immutable: a record written during impersonation % cannot be deleted',
        TG_TABLE_NAME, old_row ->> TG_ARGV[0] USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  new_row := to_jsonb(NEW);
  IF (old_row -> TG_ARGV[0]) IS DISTINCT FROM (new_row -> TG_ARGV[0]) THEN
    RAISE EXCEPTION '%_attribution_immutable: % is set when the record is written and never changes',
      TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = 'restrict_violation';
  END IF;
  IF old_row ->> TG_ARGV[0] IS NOT NULL THEN
    FOR i IN 1 .. TG_NARGS - 1 LOOP
      column_name := TG_ARGV[i];
      IF (old_row -> column_name) IS DISTINCT FROM (new_row -> column_name) THEN
        RAISE EXCEPTION '%_attribution_immutable: % of a record written during impersonation cannot change',
          TG_TABLE_NAME, column_name USING ERRCODE = 'restrict_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_logs_attribution_immutable
  BEFORE UPDATE OF "impersonation_id", "effective_user_id", "actor_user_id", "target_user_id" OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('impersonation_id', 'effective_user_id', 'actor_user_id', 'target_user_id');
CREATE TRIGGER shipment_status_history_attribution_immutable
  BEFORE UPDATE OF "impersonation_id", "actor_user_id", "actor_role", "shipment_id" OR DELETE ON "shipment_status_history"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('impersonation_id', 'actor_user_id', 'actor_role', 'shipment_id');
CREATE TRIGGER shipments_attribution_immutable
  BEFORE UPDATE OF "created_impersonation_id", "created_by_id", "creator_role", "merchant_id" OR DELETE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('created_impersonation_id', 'created_by_id', 'creator_role', 'merchant_id');
CREATE TRIGGER return_records_attribution_immutable
  BEFORE UPDATE OF "requested_impersonation_id", "requested_by_id", "shipment_id" OR DELETE ON "return_records"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('requested_impersonation_id', 'requested_by_id', 'shipment_id');
CREATE TRIGGER pricing_quotes_attribution_immutable
  BEFORE UPDATE OF "impersonation_id", "created_by_id", "merchant_id" OR DELETE ON "pricing_quotes"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('impersonation_id', 'created_by_id', 'merchant_id');
CREATE TRIGGER sessions_attribution_immutable
  BEFORE UPDATE OF "impersonation_id", "user_id", "client_app" OR DELETE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION coobra_impersonation_attribution_guard('impersonation_id', 'user_id', 'client_app');

-- ---------------------------------------------------------------------------------------------
-- Financial adjustment provenance (ADR 0003 §10.4): what an adjustment corrects. The conflict-of-
-- interest check at approval reads it; these rules make it consistent and permanent.
-- ---------------------------------------------------------------------------------------------

-- Shipment-based sources name the shipment; JOURNAL_ENTRY names the posting (which may have no
-- shipment, e.g. a payout); UNLINKED names nothing and needs a fully independent reviewer.
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_source_check" CHECK (
  ("source_type" IN ('SHIPMENT_FEE', 'RETURN_CHARGE', 'COD_SHORTFALL') AND "source_shipment_id" IS NOT NULL)
  OR ("source_type" = 'JOURNAL_ENTRY' AND "source_journal_entry_id" IS NOT NULL)
  OR ("source_type" = 'UNLINKED' AND "source_shipment_id" IS NULL AND "source_journal_entry_id" IS NULL)
);

-- When it is requested, the provenance must be real for this merchant: the shipment is the
-- merchant's, the posting moves one of the merchant's own accounts, and a posting named together
-- with a shipment is a posting for that shipment.
CREATE FUNCTION coobra_adjustment_provenance_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."source_shipment_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipments" WHERE id = NEW."source_shipment_id" AND merchant_id = NEW."merchant_id") THEN
    RAISE EXCEPTION 'financial_adjustments_provenance_check: the source shipment is not this merchant''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source_journal_entry_id" IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1 FROM "journal_lines" l JOIN "financial_accounts" a ON a.id = l.account_id
         WHERE l.entry_id = NEW."source_journal_entry_id" AND a.owner_user_id = NEW."merchant_id") THEN
      RAISE EXCEPTION 'financial_adjustments_provenance_check: the source posting does not move this merchant''s accounts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source_shipment_id" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "journal_lines" l
         WHERE l.entry_id = NEW."source_journal_entry_id" AND l.shipment_id = NEW."source_shipment_id") THEN
      RAISE EXCEPTION 'financial_adjustments_provenance_check: the source posting is not for the source shipment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_adjustments_provenance_check BEFORE INSERT ON "financial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION coobra_adjustment_provenance_check();

-- What an adjustment corrects, for whom, who asked and for how much never changes after it is
-- requested; only the decision (status, decider, note, posting) is recorded later.
CREATE FUNCTION coobra_adjustment_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."source_type", NEW."source_shipment_id", NEW."source_journal_entry_id", NEW."merchant_id",
      NEW."requested_by_id", NEW."type", NEW."amount")
     IS DISTINCT FROM
     (OLD."source_type", OLD."source_shipment_id", OLD."source_journal_entry_id", OLD."merchant_id",
      OLD."requested_by_id", OLD."type", OLD."amount") THEN
    RAISE EXCEPTION 'financial_adjustments_provenance_immutable: the source, merchant, requester, type and amount of adjustment % never change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_adjustments_provenance_immutable
  BEFORE UPDATE OF "source_type", "source_shipment_id", "source_journal_entry_id", "merchant_id", "requested_by_id", "type", "amount"
  ON "financial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION coobra_adjustment_provenance_guard();
