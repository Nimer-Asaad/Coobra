-- Phase 2: shipments, status history and COD collection records.
-- Additive only: creates new enums, tables, indexes and foreign keys; existing tables are untouched.

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ILS');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "merchant_id" UUID NOT NULL,
    "created_by_id" UUID,
    "creator_role" "UserRole" NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "recipient_phone" TEXT NOT NULL,
    "recipient_phone_alt" TEXT,
    "governorate" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "landmark" TEXT,
    "recipient_notes" TEXT,
    "merchant_notes" TEXT,
    "cod_amount" DECIMAL(12,2) NOT NULL,
    "delivery_fee" DECIMAL(12,2),
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "driver_id" UUID,
    "assigned_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "delivered_by_id" UUID,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "cancellation_reason" TEXT,
    "return_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_status_history" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "from_status" "ShipmentStatus",
    "to_status" "ShipmentStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "UserRole" NOT NULL,
    "driver_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_collections" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "collected" BOOLEAN NOT NULL,
    "expected_amount" DECIMAL(12,2) NOT NULL,
    "collected_amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_collections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tracking_number_key" ON "shipments"("tracking_number");

-- CreateIndex
CREATE INDEX "shipments_merchant_id_created_at_idx" ON "shipments"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shipments_driver_id_status_idx" ON "shipments"("driver_id", "status");

-- CreateIndex
CREATE INDEX "shipments_status_created_at_idx" ON "shipments"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "shipments_governorate_idx" ON "shipments"("governorate");

-- CreateIndex
CREATE INDEX "shipments_recipient_phone_idx" ON "shipments"("recipient_phone");

-- CreateIndex
CREATE INDEX "shipments_created_at_idx" ON "shipments"("created_at" DESC);

-- CreateIndex
CREATE INDEX "shipment_status_history_shipment_id_created_at_idx" ON "shipment_status_history"("shipment_id", "created_at");

-- CreateIndex
CREATE INDEX "shipment_status_history_actor_user_id_idx" ON "shipment_status_history"("actor_user_id");

-- CreateIndex
CREATE INDEX "cod_collections_shipment_id_idx" ON "cod_collections"("shipment_id");

-- CreateIndex
CREATE INDEX "cod_collections_driver_id_recorded_at_idx" ON "cod_collections"("driver_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money can never be negative.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cod_amount_non_negative" CHECK ("cod_amount" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_fee_non_negative" CHECK ("delivery_fee" IS NULL OR "delivery_fee" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_attempts_non_negative" CHECK ("delivery_attempts" >= 0);
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_amounts_non_negative" CHECK ("expected_amount" >= 0 AND "collected_amount" >= 0);
