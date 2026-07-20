-- Appels internes (Lunion Meet) — audio, sonnerie de groupe.
-- Additif + idempotent (Neon / double-backend, cf. conventions migrations).

-- Enum de statut d'appel (guardé : CREATE TYPE échoue si déjà présent).
DO $$ BEGIN
  CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ONGOING', 'ENDED', 'MISSED', 'CANCELLED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Table calls.
CREATE TABLE IF NOT EXISTS "calls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "room_slug" VARCHAR NOT NULL,
  "room_name" VARCHAR,
  "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
  "caller_id" UUID NOT NULL,
  "caller_type" "UserType" NOT NULL,
  "target_kind" VARCHAR NOT NULL,
  "target_restaurant_id" UUID,
  "ringing_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "answered_by_id" UUID,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- Index.
CREATE INDEX IF NOT EXISTS "calls_caller_id_idx" ON "calls"("caller_id");
CREATE INDEX IF NOT EXISTS "calls_answered_by_id_idx" ON "calls"("answered_by_id");
CREATE INDEX IF NOT EXISTS "calls_target_restaurant_id_idx" ON "calls"("target_restaurant_id");
CREATE INDEX IF NOT EXISTS "calls_status_idx" ON "calls"("status");

-- Foreign keys (guardées : ADD CONSTRAINT échoue si déjà présente).
DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey"
    FOREIGN KEY ("caller_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_target_restaurant_id_fkey"
    FOREIGN KEY ("target_restaurant_id") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_answered_by_id_fkey"
    FOREIGN KEY ("answered_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
