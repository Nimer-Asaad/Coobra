-- Merchant pickup-zone change requests. A merchant's change only takes effect when staff approve it;
-- the approved zone stays on merchant_profiles.default_pickup_zone_id. Additive: existing approved
-- zones are kept as they are.

-- CreateEnum
CREATE TYPE "PickupZoneRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "pickup_zone_requests" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "requested_zone_id" UUID NOT NULL,
    "previous_zone_id" UUID,
    "status" "PickupZoneRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pickup_zone_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pickup_zone_requests_status_created_at_idx" ON "pickup_zone_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "pickup_zone_requests_merchant_id_created_at_idx" ON "pickup_zone_requests"("merchant_id", "created_at");

-- AddForeignKey
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_requested_zone_id_fkey" FOREIGN KEY ("requested_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_previous_zone_id_fkey" FOREIGN KEY ("previous_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A decision is made by staff, never by the merchant who asked; a decided request has a time.
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_decider_not_merchant"
  CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "merchant_id");
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_decided_state"
  CHECK (("status" = 'PENDING') = ("decided_at" IS NULL));
ALTER TABLE "pickup_zone_requests" ADD CONSTRAINT "pickup_zone_requests_staff_decision"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR "decided_by_id" IS NOT NULL);

-- At most one pending request per merchant (not expressible in schema.prisma).
CREATE UNIQUE INDEX "pickup_zone_requests_one_pending_per_merchant"
  ON "pickup_zone_requests" ("merchant_id")
  WHERE "status" = 'PENDING';
