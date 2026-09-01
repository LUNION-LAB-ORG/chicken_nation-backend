-- Index de performance sur la liste des clients.
--
-- CONSTAT : le modèle Customer n'avait AUCUN index, alors que chaque page du
-- module Clients filtre sur `entity_status` et trie sur `created_at`, et que le
-- total rejoue le même filtre sur toute la table. La pagination ne protège de
-- rien dans ce cas : PostgreSQL doit balayer et trier l'ensemble avant de
-- rendre dix lignes.
--
-- ⚠️ La création d'index pose un verrou d'écriture bref sur la table. Sur une
-- table de cette taille cela se compte en secondes, mais c'est à faire hors
-- heure de pointe. `CONCURRENTLY` n'est pas utilisable ici : Prisma exécute ses
-- migrations dans une transaction, ce que cette option interdit.

-- 1. Le couple filtre + tri de toutes les listes clients.
CREATE INDEX IF NOT EXISTS "Customer_entity_status_created_at_idx"
  ON "Customer"("entity_status", "created_at");

-- 2. Recherche par fragment.
--
-- La recherche du backoffice fait `contains`, donc `ILIKE '%terme%'`. Un index
-- B-tree ordinaire est INUTILISABLE avec un joker en tête : la recherche
-- provoquait un balayage complet, sur quatre colonnes, deux fois (liste + total).
-- Les index trigrammes lèvent exactement cette limite.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ⚠️ Ces quatre index sont VOLONTAIREMENT hors du schéma Prisma, qui ne sait
-- pas exprimer `gin_trgm_ops` sans activer une fonctionnalité en avant-première.
-- Ils sont donc à recréer à la main si la base est reconstruite de zéro.
CREATE INDEX IF NOT EXISTS "Customer_first_name_trgm_idx"
  ON "Customer" USING gin ("first_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_last_name_trgm_idx"
  ON "Customer" USING gin ("last_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_phone_trgm_idx"
  ON "Customer" USING gin ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_email_trgm_idx"
  ON "Customer" USING gin ("email" gin_trgm_ops);
