-- Un seul encaissement livreur EN ATTENTE par commande, garanti PAR LA BASE.
--
-- Le dédup applicatif (findFirst puis create) est une course : webhook
-- `delivered` + `valider-code` + 2 backends parallèles peuvent créer deux
-- Paiement PENDING pour la même commande, chacun confirmable → double
-- encaissement comptable. L'index unique partiel ferme la course : le second
-- create échoue en P2002 et est traité comme « déjà enregistré ».
--
-- Migration SÉPARÉE de 20260730120000 : Postgres interdit d'utiliser une
-- valeur d'enum ajoutée dans la MÊME transaction (chaque fichier de migration
-- Prisma = une transaction).

CREATE UNIQUE INDEX IF NOT EXISTS "Paiement_order_pending_unique"
  ON "Paiement" ("order_id")
  WHERE "status" = 'PENDING';
