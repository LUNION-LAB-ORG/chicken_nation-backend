-- Planificateur v2 : regroupement par direction, retenue au comptoir, ajout
-- après le retrait tant que le livreur est au restaurant (demandes du 22/10).
--
-- Additive et rejouable : six colonnes facultatives (ou avec défaut), aucune
-- reprise de données. Les courses existantes gardent des valeurs nulles : le
-- planificateur les lit comme des courses ordinaires.

-- Départ retenu au comptoir jusqu'à cette heure (ne peut que diminuer).
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "retenue_jusqua" TIMESTAMP(6);
-- Commandes attendues par la retenue : [{ order_id, reference, prete_vers, prete_au_plus_tard }].
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "commandes_attendues" JSONB;
-- Départ réel du restaurant (null après le retrait tant que le livreur est sur place).
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "parti_at" TIMESTAMP(6);
-- « sur le trajet », « même zone »… (affichage).
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "motif_regroupement" VARCHAR(40);

-- Livraison ajoutée à une course déjà créée (ajout ou fusion).
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "ajoutee_at" TIMESTAMP(6);
-- Ajoutée après la validation du retrait (remise avec le même code ou détachée au départ).
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "ajoutee_apres_retrait" BOOLEAN NOT NULL DEFAULT false;
