-- Lieu d'habitation du livreur (choisi à l'inscription, OPTIONNEL).
-- Sert à classer les restaurants par proximité côté admin (affectation).
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "home_location" JSONB;
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "home_address" TEXT;
