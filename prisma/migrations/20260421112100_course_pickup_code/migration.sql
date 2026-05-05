-- ============================================================
-- Migration : ajout de Course.pickup_code (3 chiffres, non unique)
-- Date       : 2026-04-21
--
-- La référence (CRS-...) reste unique pour le tracking interne.
-- Le pickup_code à 3 chiffres est donné au restaurant pour récupérer les colis.
-- Collisions acceptées (1000 codes) ; résolues humainement par nom livreur + commande.
-- ============================================================

-- Aucune Course en DB pour l'instant, donc la colonne peut être NOT NULL directement.
-- Mais pour être robuste (migrations futures), on ajoute avec un default puis on le retire.
ALTER TABLE "Course" ADD COLUMN "pickup_code" VARCHAR(3) NOT NULL DEFAULT '000';
ALTER TABLE "Course" ALTER COLUMN "pickup_code" DROP DEFAULT;

-- Index non unique pour les recherches par code côté restaurant
CREATE INDEX "Course_pickup_code_idx" ON "Course"("pickup_code");
