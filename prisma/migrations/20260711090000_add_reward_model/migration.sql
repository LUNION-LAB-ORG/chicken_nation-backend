-- Récompenses « à gratter » (couche célébration au-dessus de la compta fidélité).
-- Migration IDEMPOTENTE (IF NOT EXISTS / DO blocks) : safe sur base partagée
-- entre deux backends et re-jouable sans drift (cf. précédents Neon).

-- CreateEnum RewardType
DO $$ BEGIN
    CREATE TYPE "RewardType" AS ENUM ('POINTS', 'PROMO_CODE', 'VOUCHER', 'GIFT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum RewardStatus
DO $$ BEGIN
    CREATE TYPE "RewardStatus" AS ENUM ('PENDING', 'SCRATCHED', 'REVOKED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Reward" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "RewardType" NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "reason" TEXT,
    "order_id" UUID,
    "scratched_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Reward_customer_id_status_idx" ON "Reward"("customer_id", "status");
CREATE INDEX IF NOT EXISTS "Reward_order_id_idx" ON "Reward"("order_id");

-- AddForeignKey (guardées : re-jouables)
DO $$ BEGIN
    ALTER TABLE "Reward" ADD CONSTRAINT "Reward_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Reward" ADD CONSTRAINT "Reward_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
