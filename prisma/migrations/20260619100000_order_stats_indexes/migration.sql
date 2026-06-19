-- Index ciblés pour accélérer les agrégations statistiques (Stats > Clients/Commandes).
-- Le modèle Order n'avait qu'un index [reference, status, entity_status, customer_id]
-- inutilisable pour ces requêtes (qui filtrent/groupent sur created_at, restaurant_id,
-- customer_id). Sans index, chaque cache-miss déclenche un scan complet de la table.
--
-- Idempotent (IF NOT EXISTS) pour rester sûr face au drift Neon.
-- Création NON concurrente : sur une table Order de taille modérée le verrou est bref ;
-- si la table devenait très volumineuse, préférer un CREATE INDEX CONCURRENTLY manuel
-- hors heures de pointe.

CREATE INDEX IF NOT EXISTS "Order_restaurant_id_created_at_idx"
  ON "Order" ("restaurant_id", "created_at");

CREATE INDEX IF NOT EXISTS "Order_customer_id_created_at_idx"
  ON "Order" ("customer_id", "created_at");

CREATE INDEX IF NOT EXISTS "Order_created_at_idx"
  ON "Order" ("created_at");
