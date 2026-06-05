-- Module « Base de Données » : captation/conversion des clients Glovo/Yango (SPEC-CN-BDD-001).
-- Migration ciblée + idempotente (style Neon) pour éviter le drift.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ProspectPlatform" AS ENUM ('GLOVO', 'YANGO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProspectStatus" AS ENUM ('NOUVEAU', 'A_APPELER', 'JOINT', 'NON_JOIGNABLE', 'REFUS', 'COUPON_ENVOYE', 'INSCRIT', 'CONVERTI');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProspectCallResult" AS ENUM ('JOINT', 'NON_JOIGNABLE', 'REFUS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProspectMessageKind" AS ENUM ('DECOUVERTE', 'RELANCE_1', 'RELANCE_2_FIDELITE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable Prospect
CREATE TABLE IF NOT EXISTS "Prospect" (
  "id"             UUID                NOT NULL,
  "platform"       "ProspectPlatform"  NOT NULL,
  "name"           VARCHAR             NOT NULL,
  "order_number"   VARCHAR             NOT NULL,
  "phone"          VARCHAR             NOT NULL,
  "status"         "ProspectStatus"    NOT NULL DEFAULT 'NOUVEAU',
  "restaurant_id"  UUID                NOT NULL,
  "created_by"     UUID,
  "customer_id"    UUID,
  "promo_code_id"  UUID,
  "called_at"      TIMESTAMP(3),
  "coupon_sent_at" TIMESTAMP(3),
  "registered_at"  TIMESTAMP(3),
  "converted_at"   TIMESTAMP(3),
  "entity_status"  "EntityStatus"      NOT NULL DEFAULT 'ACTIVE',
  "created_at"     TIMESTAMP(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable ProspectCall
CREATE TABLE IF NOT EXISTS "ProspectCall" (
  "id"          UUID                 NOT NULL,
  "prospect_id" UUID                 NOT NULL,
  "agent_id"    UUID,
  "result"      "ProspectCallResult" NOT NULL,
  "rank"        INTEGER              NOT NULL DEFAULT 1,
  "note"        VARCHAR,
  "created_at"  TIMESTAMP(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProspectCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable ProspectMessage
CREATE TABLE IF NOT EXISTS "ProspectMessage" (
  "id"          UUID                  NOT NULL,
  "prospect_id" UUID                  NOT NULL,
  "kind"        "ProspectMessageKind" NOT NULL,
  "rank"        INTEGER               NOT NULL DEFAULT 1,
  "body"        TEXT                  NOT NULL,
  "created_at"  TIMESTAMP(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProspectMessage_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Prospect_phone_idx" ON "Prospect"("phone");
CREATE INDEX IF NOT EXISTS "Prospect_restaurant_id_status_created_at_idx" ON "Prospect"("restaurant_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "ProspectCall_prospect_id_created_at_idx" ON "ProspectCall"("prospect_id", "created_at");
CREATE INDEX IF NOT EXISTS "ProspectMessage_prospect_id_created_at_idx" ON "ProspectMessage"("prospect_id", "created_at");

-- Foreign keys (idempotent)
DO $$ BEGIN
  ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ProspectCall" ADD CONSTRAINT "ProspectCall_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ProspectCall" ADD CONSTRAINT "ProspectCall_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ProspectMessage" ADD CONSTRAINT "ProspectMessage_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
