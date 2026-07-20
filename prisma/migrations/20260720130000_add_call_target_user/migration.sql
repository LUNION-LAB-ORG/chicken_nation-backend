-- Appel P2P : cible individuelle (ex : admin appelle une personne précise).
-- Additif + idempotent (Neon / double-backend).

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "target_user_id" UUID;

CREATE INDEX IF NOT EXISTS "calls_target_user_id_idx" ON "calls"("target_user_id");

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_target_user_id_fkey"
    FOREIGN KEY ("target_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
