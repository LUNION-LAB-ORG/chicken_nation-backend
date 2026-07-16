-- Photo du titulaire de la demande de Carte de la Nation (contrôle backoffice).
-- Idempotent : IF NOT EXISTS pour cohabiter avec un double backend / re-run.
-- Nullable : les demandes existantes n'ont pas de photo.
ALTER TABLE "CardRequest" ADD COLUMN IF NOT EXISTS "photo" TEXT;
