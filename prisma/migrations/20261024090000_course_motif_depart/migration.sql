-- Départ du restaurant : ce qui a posé `Course.parti_at` (relecture du 24/10).
--
-- Additive et rejouable : une colonne facultative, aucune reprise de données.
-- Départ réel (BOUTON, POSITION, LIVRAISON_DEMARREE, FENETRE_ECHUE) ou fenêtre
-- fermée d'office à la validation (ANCIENNE_APPLI, REPLI_V1, AJOUT_COUPE…) :
-- la caisse et le backoffice ne le déduisent plus des heures. Les courses
-- existantes gardent une valeur nulle (lue comme avant).
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "motif_depart" VARCHAR(40);
