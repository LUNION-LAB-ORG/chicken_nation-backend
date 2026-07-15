-- Loyalty Phase 1 : renommage des niveaux (PREMIUM->VIP, GOLD->VVIP),
-- ajout du compteur ANNUEL `status_points`, backfill (12 derniers mois) et
-- recalcul du niveau sur les seuils de la config active.
-- Migration idempotente (ré-exécutable sans erreur).

-- 1) Renommer les valeurs de l'enum LoyaltyLevel (garde le même OID → utilisable
--    immédiatement plus bas, même transaction). Gardé par un check d'existence
--    pour rester idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LoyaltyLevel' AND e.enumlabel = 'PREMIUM'
  ) THEN
    ALTER TYPE "LoyaltyLevel" RENAME VALUE 'PREMIUM' TO 'VIP';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LoyaltyLevel' AND e.enumlabel = 'GOLD'
  ) THEN
    ALTER TYPE "LoyaltyLevel" RENAME VALUE 'GOLD' TO 'VVIP';
  END IF;
END
$$;

-- 2) Compteur annuel de points de STATUT (base de calcul du niveau).
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "status_points" INTEGER NOT NULL DEFAULT 0;

-- 3) Backfill : somme des points EARNED des 12 derniers mois (ledger LoyaltyPoint).
UPDATE "Customer" c
SET "status_points" = COALESCE((
  SELECT SUM(lp."points")
  FROM "LoyaltyPoint" lp
  WHERE lp."customer_id" = c."id"
    AND lp."type" = 'EARNED'
    AND lp."created_at" > now() - interval '12 months'
), 0);

-- 4) Recompute du niveau depuis status_points vs les seuils de la LoyaltyConfig
--    active (fallback sur les défauts si aucune config active).
UPDATE "Customer" c
SET "loyalty_level" = (
  CASE
    WHEN c."status_points" >= cfg.gold_threshold THEN 'VVIP'
    WHEN c."status_points" >= cfg.premium_threshold THEN 'VIP'
    WHEN c."status_points" >= cfg.standard_threshold THEN 'STANDARD'
    ELSE NULL
  END
)::"LoyaltyLevel"
FROM (
  SELECT
    COALESCE(MAX("standard_threshold"), 300)  AS standard_threshold,
    COALESCE(MAX("premium_threshold"), 700)   AS premium_threshold,
    COALESCE(MAX("gold_threshold"), 1000)     AS gold_threshold
  FROM "LoyaltyConfig"
  WHERE "is_active" = true
) cfg;
