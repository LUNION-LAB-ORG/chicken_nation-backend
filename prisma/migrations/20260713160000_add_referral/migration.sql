-- Parrainage : code de parrainage sur Customer + table Referral (parrain→filleul).
-- Additif + idempotent (Neon / double-backend, cf. conventions migrations).

-- Enum ReferralStatus (guardé : CREATE TYPE échoue si déjà présent).
DO $$ BEGIN
  CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Code de parrainage partageable (unique) sur le client.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_referral_code_key" ON "Customer"("referral_code");

-- Table Referral.
CREATE TABLE IF NOT EXISTS "Referral" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "referrer_id" UUID NOT NULL,
  "referee_id" UUID NOT NULL,
  "referral_code" VARCHAR NOT NULL,
  "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
  "qualifying_order_id" UUID,
  "welcome_voucher_id" UUID,
  "parrain_reward_id" UUID,
  "qualified_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Referral_referee_id_key" ON "Referral"("referee_id");
CREATE INDEX IF NOT EXISTS "Referral_referrer_id_status_idx" ON "Referral"("referrer_id", "status");
CREATE INDEX IF NOT EXISTS "Referral_status_idx" ON "Referral"("status");

-- Clés étrangères (guardées).
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrer_id_fkey"
    FOREIGN KEY ("referrer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referee_id_fkey"
    FOREIGN KEY ("referee_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
