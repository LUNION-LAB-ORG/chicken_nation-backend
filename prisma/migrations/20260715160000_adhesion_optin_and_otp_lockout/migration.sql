-- TUNNEL D'ADHÉSION (Phase 4) + DURCISSEMENT OTP
-- Migration IDEMPOTENTE : rejouable sans erreur (double backend / réconciliations).

-- 1) Customer : consentement WhatsApp (opt-in) recueilli à l'adhésion (conformité)
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "whatsapp_opt_in_at" TIMESTAMP(6);

-- 2) Customer : profil déclaratif choisi à l'adhésion (réutilise l'enum ProfileType
--    créé en Phase 3). Nullable : les clients existants n'ont rien déclaré.
--    (Garde-fou : re-crée l'enum si la migration Phase 3 n'a pas encore tourné.)
DO $$
BEGIN
  CREATE TYPE "ProfileType" AS ENUM ('ETUDIANT', 'PROFESSIONNEL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "profile_type" "ProfileType";

-- 3) Durcissement OTP : plafond de tentatives de vérification + lockout par numéro
CREATE TABLE IF NOT EXISTS "OtpVerificationAttempt" (
  "id"           UUID NOT NULL,
  "phone"        VARCHAR NOT NULL,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "window_start" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_until" TIMESTAMP(6),
  "updated_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OtpVerificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OtpVerificationAttempt_phone_key"
  ON "OtpVerificationAttempt" ("phone");
CREATE INDEX IF NOT EXISTS "OtpVerificationAttempt_phone_idx"
  ON "OtpVerificationAttempt" ("phone");
