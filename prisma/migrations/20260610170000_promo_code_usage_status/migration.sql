-- Cycle de vie de l'usage d'un code promo : INACTIVE à la création (commande
-- PENDING non payée), ACTIVE quand la commande devient ACCEPTED (payée),
-- re-INACTIVE si annulée. Seuls les usages ACTIVE comptent dans usage_count
-- et les analytics.

-- CreateEnum
CREATE TYPE "PromoCodeUsageStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable : nouvelle colonne, défaut INACTIVE
ALTER TABLE "PromoCodeUsage"
  ADD COLUMN "status" "PromoCodeUsageStatus" NOT NULL DEFAULT 'INACTIVE';

-- CreateIndex
CREATE INDEX "PromoCodeUsage_order_id_idx" ON "PromoCodeUsage"("order_id");

-- ─── Backfill atomique des données existantes ──────────────────────────────
-- Un usage rattaché à une commande déjà payée/avancée (ACCEPTED → COMPLETED)
-- est comptabilisé → ACTIVE. Les commandes PENDING (non payées) / CANCELLED
-- ou sans commande restent INACTIVE (défaut).
UPDATE "PromoCodeUsage" pcu
SET "status" = 'ACTIVE'
FROM "Order" o
WHERE pcu."order_id" = o."id"
  AND o."status" IN ('ACCEPTED', 'IN_PROGRESS', 'READY', 'PICKED_UP', 'COLLECTED', 'COMPLETED');

-- Recaler usage_count = nombre d'usages ACTIVE par code.
UPDATE "PromoCode" pc
SET "usage_count" = (
  SELECT COUNT(*) FROM "PromoCodeUsage" u
  WHERE u."promo_code_id" = pc."id" AND u."status" = 'ACTIVE'
);
