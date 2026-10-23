-- Offre posée par l'affectation forcée de l'administrateur.
--
-- Le planificateur v2 reprenait cette offre dans la demi-seconde quand un
-- autre livreur libre était plus proche (reprise « zéro temps mort ») ou la
-- fermait par une fusion : le geste manuel était défait en silence. Une offre
-- forcée n'est plus jamais reprise ni close par une fusion.
--
-- Additive et rejouable : colonne avec défaut, aucune reprise de données.
ALTER TABLE "CourseOfferAttempt" ADD COLUMN IF NOT EXISTS "forcee" BOOLEAN NOT NULL DEFAULT false;
