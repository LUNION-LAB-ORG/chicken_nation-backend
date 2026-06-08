-- =====================================================================================
-- Épicé à 3 états (SpiceLevel) sur Dish et Supplement.
--
-- ADDITIF + IDEMPOTENT (aucune perte de données) :
--  - nouvel enum "SpiceLevel" (ALWAYS / OPTIONAL / NEVER)
--  - nouvelle colonne "spice_level" sur Dish (défaut OPTIONAL) et Supplement (défaut NEVER)
--  - backfill Dish depuis l'ancien booléen "is_alway_epice" (CONSERVÉ pour compat/rollback)
-- =====================================================================================

-- 1) Enum SpiceLevel (créé une seule fois)
DO $$ BEGIN
  CREATE TYPE "SpiceLevel" AS ENUM ('ALWAYS', 'OPTIONAL', 'NEVER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2) Colonnes (NOT NULL avec défaut → les lignes existantes prennent le défaut)
ALTER TABLE "Dish"       ADD COLUMN IF NOT EXISTS "spice_level" "SpiceLevel" NOT NULL DEFAULT 'OPTIONAL';
ALTER TABLE "Supplement" ADD COLUMN IF NOT EXISTS "spice_level" "SpiceLevel" NOT NULL DEFAULT 'NEVER';

-- 3) Backfill Dish : is_alway_epice = true -> ALWAYS (le reste reste OPTIONAL = défaut)
UPDATE "Dish" SET "spice_level" = 'ALWAYS' WHERE "is_alway_epice" = true;
