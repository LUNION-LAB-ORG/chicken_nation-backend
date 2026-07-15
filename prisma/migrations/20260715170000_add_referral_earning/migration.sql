-- Parrainage — VOLET MONÉTAIRE (Phase 5) : registre comptable des gains ambassadeur.
-- Additif + idempotent (Neon / double-backend, cf. conventions migrations).

-- Enums (guardés : CREATE TYPE échoue si déjà présent).
DO $$ BEGIN
  CREATE TYPE "ReferralEarningType" AS ENUM ('PRIME', 'COMMISSION');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReferralEarningStatus" AS ENUM ('PENDING', 'PAYABLE', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Table ReferralEarning.
CREATE TABLE IF NOT EXISTS "ReferralEarning" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "referral_id" UUID NOT NULL,
  "referrer_id" UUID NOT NULL,
  "referee_id" UUID NOT NULL,
  "type" "ReferralEarningType" NOT NULL,
  "source_order_id" UUID,
  "amount" INTEGER NOT NULL,
  "status" "ReferralEarningStatus" NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  "paid_by" UUID,
  "paid_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralEarning_pkey" PRIMARY KEY ("id")
);

-- Idempotence : au plus 1 PRIME et 1 COMMISSION par commande source.
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralEarning_source_order_id_type_key"
  ON "ReferralEarning"("source_order_id", "type");
CREATE INDEX IF NOT EXISTS "ReferralEarning_referrer_id_status_idx"
  ON "ReferralEarning"("referrer_id", "status");
CREATE INDEX IF NOT EXISTS "ReferralEarning_referral_id_idx"
  ON "ReferralEarning"("referral_id");
CREATE INDEX IF NOT EXISTS "ReferralEarning_status_idx"
  ON "ReferralEarning"("status");

-- Clés étrangères (guardées).
DO $$ BEGIN
  ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "Referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_referrer_id_fkey"
    FOREIGN KEY ("referrer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_referee_id_fkey"
    FOREIGN KEY ("referee_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_source_order_id_fkey"
    FOREIGN KEY ("source_order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_paid_by_fkey"
    FOREIGN KEY ("paid_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
