-- Phase 3 (A): zones, pricing rules, quotes, pricing snapshots and fee overrides.
-- Additive: new tables plus nullable columns on merchant_profiles and shipments.

-- CreateEnum
CREATE TYPE "PricingSource" AS ENUM ('MERCHANT_ROUTE', 'GENERAL_ROUTE', 'MERCHANT_FALLBACK', 'GENERAL_FALLBACK', 'MANUAL', 'LEGACY');

-- CreateEnum
CREATE TYPE "FeeOverridePhase" AS ENUM ('PRE_DELIVERY', 'POST_DELIVERY');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('APPLIED', 'PENDING_APPROVAL', 'REJECTED');

-- AlterTable
ALTER TABLE "merchant_profiles" ADD COLUMN     "default_pickup_zone_id" UUID;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "destination_zone_id" UUID,
ADD COLUMN     "origin_zone_id" UUID;

-- CreateTable
CREATE TABLE "zone_kinds" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zone_kinds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind_id" UUID NOT NULL,
    "parent_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "rule_group_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "merchant_id" UUID,
    "origin_zone_id" UUID,
    "destination_zone_id" UUID,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "delivery_fee" DECIMAL(12,2) NOT NULL,
    "return_fee" DECIMAL(12,2),
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_quotes" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "origin_zone_id" UUID NOT NULL,
    "destination_zone_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "source" "PricingSource" NOT NULL,
    "delivery_fee" DECIMAL(12,2) NOT NULL,
    "return_fee" DECIMAL(12,2),
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "shipment_id" UUID,

    CONSTRAINT "pricing_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_pricing" (
    "shipment_id" UUID NOT NULL,
    "quote_id" UUID,
    "rule_id" UUID,
    "rule_version" INTEGER,
    "source" "PricingSource" NOT NULL,
    "origin_zone_id" UUID,
    "destination_zone_id" UUID,
    "base_fee" DECIMAL(12,2),
    "final_fee" DECIMAL(12,2) NOT NULL,
    "return_fee" DECIMAL(12,2),
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "priced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priced_by_id" UUID,

    CONSTRAINT "shipment_pricing_pkey" PRIMARY KEY ("shipment_id")
);

-- CreateTable
CREATE TABLE "shipment_fee_overrides" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "phase" "FeeOverridePhase" NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "previous_fee" DECIMAL(12,2),
    "new_fee" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_role" "UserRole" NOT NULL,
    "approved_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_fee_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zone_kinds_code_key" ON "zone_kinds"("code");

-- CreateIndex
CREATE UNIQUE INDEX "zones_code_key" ON "zones"("code");

-- CreateIndex
CREATE INDEX "zones_parent_id_idx" ON "zones"("parent_id");

-- CreateIndex
CREATE INDEX "pricing_rules_active_merchant_id_idx" ON "pricing_rules"("active", "merchant_id");

-- CreateIndex
CREATE INDEX "pricing_rules_origin_zone_id_destination_zone_id_idx" ON "pricing_rules"("origin_zone_id", "destination_zone_id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_rule_group_id_version_key" ON "pricing_rules"("rule_group_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_quotes_shipment_id_key" ON "pricing_quotes"("shipment_id");

-- CreateIndex
CREATE INDEX "pricing_quotes_merchant_id_created_at_idx" ON "pricing_quotes"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_pricing_quote_id_key" ON "shipment_pricing"("quote_id");

-- CreateIndex
CREATE INDEX "shipment_fee_overrides_shipment_id_created_at_idx" ON "shipment_fee_overrides"("shipment_id", "created_at");

-- CreateIndex
CREATE INDEX "shipments_destination_zone_id_idx" ON "shipments"("destination_zone_id");

-- AddForeignKey
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_default_pickup_zone_id_fkey" FOREIGN KEY ("default_pickup_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_zone_id_fkey" FOREIGN KEY ("origin_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destination_zone_id_fkey" FOREIGN KEY ("destination_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_kind_id_fkey" FOREIGN KEY ("kind_id") REFERENCES "zone_kinds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_origin_zone_id_fkey" FOREIGN KEY ("origin_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_destination_zone_id_fkey" FOREIGN KEY ("destination_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "pricing_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_pricing" ADD CONSTRAINT "shipment_pricing_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_pricing" ADD CONSTRAINT "shipment_pricing_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "pricing_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_fee_overrides" ADD CONSTRAINT "shipment_fee_overrides_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_fee_overrides" ADD CONSTRAINT "shipment_fee_overrides_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_fee_overrides" ADD CONSTRAINT "shipment_fee_overrides_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rule shape and non-negative money.
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_route_or_fallback"
  CHECK (("is_fallback" AND "origin_zone_id" IS NULL AND "destination_zone_id" IS NULL)
      OR (NOT "is_fallback" AND "origin_zone_id" IS NOT NULL AND "destination_zone_id" IS NOT NULL));
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_fees_non_negative"
  CHECK ("delivery_fee" >= 0 AND ("return_fee" IS NULL OR "return_fee" >= 0));
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_effective_window"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_fees_non_negative"
  CHECK ("delivery_fee" >= 0 AND ("return_fee" IS NULL OR "return_fee" >= 0));
ALTER TABLE "shipment_pricing" ADD CONSTRAINT "shipment_pricing_fees_non_negative"
  CHECK ("final_fee" >= 0 AND ("base_fee" IS NULL OR "base_fee" >= 0) AND ("return_fee" IS NULL OR "return_fee" >= 0));
ALTER TABLE "shipment_fee_overrides" ADD CONSTRAINT "shipment_fee_overrides_fee_non_negative"
  CHECK ("new_fee" >= 0);
ALTER TABLE "zones" ADD CONSTRAINT "zones_depth_matches_parent" CHECK (("parent_id" IS NULL) = ("depth" = 0));

-- Configurable zone level labels.
INSERT INTO "zone_kinds" ("id", "code", "name_ar", "name_en", "sort_order", "updated_at") VALUES
  (gen_random_uuid(), 'REGION',      'منطقة',          'Region',      0, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'GOVERNORATE', 'محافظة',         'Governorate', 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'CITY',        'مدينة',          'City',        2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'TOWN',        'بلدة / قرية',    'Town',        3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'SUBZONE',     'منطقة فرعية',    'Subzone',     4, CURRENT_TIMESTAMP);

-- Root zones reuse the Phase 2 governorate codes, so existing shipments map 1:1.
INSERT INTO "zones" ("id", "code", "kind_id", "depth", "name_ar", "name_en", "sort_order", "updated_at")
SELECT gen_random_uuid(), v.code, k.id, 0, v.name_ar, v.name_en, v.sort_order, CURRENT_TIMESTAMP
FROM (VALUES
  ('JERUSALEM',        'القدس',             'Jerusalem',                          1, 'GOVERNORATE'),
  ('RAMALLAH_ALBIREH', 'رام الله والبيرة',  'Ramallah & Al-Bireh',                2, 'GOVERNORATE'),
  ('NABLUS',           'نابلس',             'Nablus',                             3, 'GOVERNORATE'),
  ('HEBRON',           'الخليل',            'Hebron',                             4, 'GOVERNORATE'),
  ('BETHLEHEM',        'بيت لحم',           'Bethlehem',                          5, 'GOVERNORATE'),
  ('JENIN',            'جنين',              'Jenin',                              6, 'GOVERNORATE'),
  ('TULKARM',          'طولكرم',            'Tulkarm',                            7, 'GOVERNORATE'),
  ('QALQILYA',         'قلقيلية',           'Qalqilya',                           8, 'GOVERNORATE'),
  ('SALFIT',           'سلفيت',             'Salfit',                             9, 'GOVERNORATE'),
  ('JERICHO',          'أريحا والأغوار',    'Jericho & Al-Aghwar',               10, 'GOVERNORATE'),
  ('TUBAS',            'طوباس',             'Tubas',                             11, 'GOVERNORATE'),
  ('NORTH_GAZA',       'شمال غزة',          'North Gaza',                        12, 'GOVERNORATE'),
  ('GAZA',             'غزة',               'Gaza',                              13, 'GOVERNORATE'),
  ('DEIR_AL_BALAH',    'دير البلح',         'Deir al-Balah',                     14, 'GOVERNORATE'),
  ('KHAN_YUNIS',       'خان يونس',          'Khan Yunis',                        15, 'GOVERNORATE'),
  ('RAFAH',            'رفح',               'Rafah',                             16, 'GOVERNORATE'),
  ('INSIDE_48',        'الداخل (أراضي 48)', 'Inside the Green Line (1948 areas)', 17, 'REGION')
) AS v(code, name_ar, name_en, sort_order, kind)
JOIN "zone_kinds" k ON k.code = v.kind;

-- Existing shipments: destination zone from the governorate code (no other column changes).
UPDATE "shipments" s SET "destination_zone_id" = z.id FROM "zones" z WHERE z.code = s.governorate AND s."destination_zone_id" IS NULL;
