-- Phase 3 (F1): physical return statuses. Enum values only (used from the next migration on).

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ShipmentStatus" ADD VALUE 'RETURN_APPROVED' BEFORE 'RETURNED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'RETURN_IN_TRANSIT' BEFORE 'RETURNED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'RETURNED_TO_HUB' BEFORE 'RETURNED';
