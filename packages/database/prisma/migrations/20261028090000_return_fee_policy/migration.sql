-- Configurable return-fee policy (additive). Every existing pricing rule, pricing snapshot and
-- return record keeps the Phase 3 behaviour (RETURN_ONLY, no extra charge) through the defaults.
-- No existing row or journal entry is rewritten.

CREATE TYPE "ReturnFeePolicy" AS ENUM ('RETURN_ONLY', 'DELIVERY_PLUS_RETURN', 'REDUCED_ATTEMPT_PLUS_RETURN');

ALTER TABLE "pricing_rules"
  ADD COLUMN "return_policy" "ReturnFeePolicy" NOT NULL DEFAULT 'RETURN_ONLY',
  ADD COLUMN "attempt_fee" DECIMAL(12,2);

ALTER TABLE "shipment_pricing"
  ADD COLUMN "return_policy" "ReturnFeePolicy" NOT NULL DEFAULT 'RETURN_ONLY',
  ADD COLUMN "attempt_fee" DECIMAL(12,2);

ALTER TABLE "return_records"
  ADD COLUMN "fee_policy" "ReturnFeePolicy" NOT NULL DEFAULT 'RETURN_ONLY',
  ADD COLUMN "delivery_charge" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- An attempt fee exists exactly when the policy uses it, and is never negative or above the
-- delivery fee. Check constraints are not expressible in schema.prisma; Prisma ignores them.
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_attempt_fee_matches_policy" CHECK (
  ("return_policy" = 'REDUCED_ATTEMPT_PLUS_RETURN') = ("attempt_fee" IS NOT NULL)
  AND ("attempt_fee" IS NULL OR ("attempt_fee" >= 0 AND "attempt_fee" <= "delivery_fee"))
);
ALTER TABLE "shipment_pricing" ADD CONSTRAINT "shipment_pricing_attempt_fee_matches_policy" CHECK (
  ("return_policy" = 'REDUCED_ATTEMPT_PLUS_RETURN') = ("attempt_fee" IS NOT NULL)
  AND ("attempt_fee" IS NULL OR "attempt_fee" >= 0)
);
ALTER TABLE "return_records" ADD CONSTRAINT "return_records_delivery_charge_non_negative" CHECK (
  "delivery_charge" >= 0
  AND ("fee_policy" <> 'RETURN_ONLY' OR "delivery_charge" = 0)
);
