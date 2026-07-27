-- Plafond de tentatives sur la validation du code client par un livreur Turbo.
-- Le code fait 4 chiffres (10 000 combinaisons) : sans plafond, il est
-- brute-forçable en quelques minutes par quiconque détient une clé API valide.
-- Au-delà du seuil, la validation est bloquée et le staff alerté.
--
-- Additif + idempotent.

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "turbo_code_attempts" INTEGER NOT NULL DEFAULT 0;
