-- CARTE DE LA NATION — Phase 3 (V1 déclaratif + thème couleur + snapshot niveau)
-- Migration IDEMPOTENTE : rejouable sans erreur (double backend / réconciliations).

-- 1) Nouvel enum de profil déclaratif
DO $$
BEGIN
  CREATE TYPE "ProfileType" AS ENUM ('ETUDIANT', 'PROFESSIONNEL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- 2) CardRequest : institution + justificatif deviennent OPTIONNELS (V1 sans justificatif)
ALTER TABLE "CardRequest" ALTER COLUMN "institution" DROP NOT NULL;
ALTER TABLE "CardRequest" ALTER COLUMN "student_card_file_url" DROP NOT NULL;

-- 3) CardRequest : profil déclaratif. Les demandes existantes portaient un justificatif
--    étudiant → on les backfille en ETUDIANT (via le DEFAULT de la colonne).
ALTER TABLE "CardRequest"
  ADD COLUMN IF NOT EXISTS "profile_type" "ProfileType" NOT NULL DEFAULT 'ETUDIANT';

-- 4) NationCard : snapshot du niveau au moment de la génération + marqueur étudiant
ALTER TABLE "NationCard"
  ADD COLUMN IF NOT EXISTS "level" "LoyaltyLevel";
ALTER TABLE "NationCard"
  ADD COLUMN IF NOT EXISTS "is_student" BOOLEAN NOT NULL DEFAULT false;
