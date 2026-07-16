-- Ciblage d'audience des plats.
-- Enum DishAudience + colonne Dish.audiences ([] = PUBLIC, tout le monde).
-- Idempotent (rejouable sans erreur).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DishAudience') THEN
    CREATE TYPE "DishAudience" AS ENUM ('ETUDIANT', 'STANDARD', 'VIP', 'VVIP');
  END IF;
END$$;

ALTER TABLE "Dish"
  ADD COLUMN IF NOT EXISTS "audiences" "DishAudience"[] NOT NULL DEFAULT ARRAY[]::"DishAudience"[];

-- CardRequest.profile_type : nullable, sans défaut.
-- NULL = grand public (non-étudiant) ; ETUDIANT = carte étudiant.
-- (DROP NOT NULL / DROP DEFAULT sont des no-op si déjà appliqués → idempotent.)
ALTER TABLE "CardRequest" ALTER COLUMN "profile_type" DROP NOT NULL;
ALTER TABLE "CardRequest" ALTER COLUMN "profile_type" DROP DEFAULT;
