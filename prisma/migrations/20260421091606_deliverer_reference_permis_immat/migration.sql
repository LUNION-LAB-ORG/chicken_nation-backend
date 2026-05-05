-- ============================================================
-- Migration : ajout de la référence métier + numéro permis + immatriculation
-- Date       : 2026-04-21
-- Ciblée     : 3 colonnes sur la table Deliverer (+ unique index reference)
-- Aucune autre table n'est touchée.
--
-- IMPORTANT : `reference` est NOT NULL mais on crée la colonne en NULL,
-- on remplit les lignes existantes avec un temporaire basé sur l'UUID,
-- PUIS on met la contrainte NOT NULL + UNIQUE.
-- ============================================================

-- AddColumn reference (nullable temporairement pour accueillir les lignes existantes)
ALTER TABLE "Deliverer" ADD COLUMN "reference" VARCHAR(20);

-- Remplir les lignes existantes avec une reference dérivée de l'id (format LIV-<10 chars>)
UPDATE "Deliverer" SET "reference" = 'LIV-' || UPPER(SUBSTRING(REPLACE("id"::text, '-', ''), 1, 10)) WHERE "reference" IS NULL;

-- Passer en NOT NULL + UNIQUE
ALTER TABLE "Deliverer" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "Deliverer_reference_key" ON "Deliverer"("reference");

-- AddColumn numero_permis + numero_immatriculation (toujours optionnels)
ALTER TABLE "Deliverer" ADD COLUMN "numero_permis" VARCHAR(100);
ALTER TABLE "Deliverer" ADD COLUMN "numero_immatriculation" VARCHAR(50);
