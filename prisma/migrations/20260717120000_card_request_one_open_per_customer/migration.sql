-- Flux de RÉVISION de carte (modif photo/pseudo/statut étudiant depuis l'app).
--
-- Problème : @@unique([customer_id, status]) n'autorisait QU'UNE demande par
-- statut et par client. Le cycle d'une révision est pourtant :
--   APPROVED (carte initiale) → IN_REVIEW (demande de modif) → APPROVED (validée)
-- La 2e APPROVED entrait en collision (P2002) → l'approbation d'une révision
-- plantait. Contourner en passant l'ancienne en EXPIRED ne fait que déplacer la
-- collision sur EXPIRED au tour suivant : la contrainte devait sauter.
--
-- Remplacement : index unique PARTIEL — « une seule demande OUVERTE par client »
-- (PENDING ou IN_REVIEW), sans jamais brider l'historique des demandes closes.
-- Prisma ne sait pas exprimer un index partiel → SQL manuscrit (convention du
-- projet) et la contrainte est retirée du schéma Prisma.
--
-- Vérifié avant écriture sur la prod : 0 client n'a plusieurs demandes ouvertes,
-- donc la création de l'index unique ne peut pas échouer sur l'existant.
DROP INDEX IF EXISTS "CardRequest_customer_id_status_key";

CREATE UNIQUE INDEX IF NOT EXISTS "card_request_one_open_per_customer"
  ON "CardRequest" ("customer_id")
  WHERE status IN ('PENDING', 'IN_REVIEW');

-- Motif de la révision, généré automatiquement pour les demandes issues de l'app
-- (« Changement de photo », « Nouveau pseudo : … ») → le staff voit pourquoi la
-- demande revient dans la liste.
ALTER TABLE "CardRequest" ADD COLUMN IF NOT EXISTS "revision_reason" TEXT;
