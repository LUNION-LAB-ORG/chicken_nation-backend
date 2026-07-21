-- Appels : liste IMMUABLE des receveurs sonnés à l'origine.
-- `ringing_user_ids` mute (refus) et était vidée sur CANCELLED/MISSED, ce qui
-- faisait disparaître les appels manqués de l'historique des receveurs.
-- Additif + idempotent (Neon / double-backend).

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "rung_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill best-effort : pour les appels existants encore porteurs de la liste.
UPDATE "calls" SET "rung_user_ids" = "ringing_user_ids"
WHERE "rung_user_ids" = ARRAY[]::TEXT[] AND "ringing_user_ids" <> ARRAY[]::TEXT[];
