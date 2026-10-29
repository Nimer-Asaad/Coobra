-- Phase 4B audit log viewer. Additive only: new indexes, no table or data changes.

-- Newest-first pages with a stable tie-break.
CREATE INDEX "audit_logs_created_at_id_idx" ON "audit_logs"("created_at" DESC, "id" DESC);

-- One person's history (as actor or as target), newest first.
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);
CREATE INDEX "audit_logs_target_user_id_created_at_idx" ON "audit_logs"("target_user_id", "created_at" DESC);

-- Entity lookups (shipment, settlement, payout, ...) by metadata containment (@>) and key (?).
CREATE INDEX "audit_logs_metadata_idx" ON "audit_logs" USING GIN ("metadata" jsonb_ops);
