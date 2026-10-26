-- One ledger posting per COD collection and per shipment delivery fee, whichever path posts it.
-- (kind, source_type, source_id) is already unique, but the live path and the Phase 2 backfill
-- use different kinds for the same source, so that constraint alone would allow both.
-- Partial indexes are not expressible in schema.prisma; Prisma ignores them when diffing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "journal_entries" WHERE "source_type" = 'cod_collection'
    GROUP BY "source_id" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'A COD collection is posted more than once; resolve it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "journal_entries"
    WHERE "kind" = 'DELIVERY_FEE' OR ("kind" = 'PHASE2_BACKFILL' AND "source_type" = 'shipment_fee')
    GROUP BY "source_id" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'A delivery fee is posted more than once; resolve it before this migration';
  END IF;
END $$;

-- COD_COLLECTION (live) and PHASE2_BACKFILL both post source_type 'cod_collection'.
CREATE UNIQUE INDEX "journal_entries_one_cod_collection_posting"
  ON "journal_entries" ("source_id")
  WHERE "source_type" = 'cod_collection';

-- DELIVERY_FEE (source_type 'shipment') and the backfilled fee (source_type 'shipment_fee') both
-- use the shipment id. Corrections post FEE_ADJUSTMENT entries and are not covered here.
CREATE UNIQUE INDEX "journal_entries_one_delivery_fee_posting"
  ON "journal_entries" ("source_id")
  WHERE "kind" = 'DELIVERY_FEE' OR ("kind" = 'PHASE2_BACKFILL' AND "source_type" = 'shipment_fee');
