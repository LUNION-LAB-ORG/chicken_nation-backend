-- Index sur les clés étrangères les plus lues (14/11/2026).
--
-- Constat sur la base de production (statistiques de PostgreSQL) : trois tables
-- n'avaient aucun index utile sur la colonne qui les relie à la commande ou au
-- client, donc chaque lecture les balayait en entier :
--   "Address"   : 65 millions de balayages complets, 1 030 milliards de lignes lues ;
--   "OrderItem" : 24 millions de balayages complets,   687 milliards de lignes lues ;
--   "Paiement"  : 29 millions de balayages complets,   539 milliards de lignes lues.
-- Le processeur de Neon était au plafond de son calcul, et les listes du
-- backoffice (commandes, opérations en cours) répondaient en 500 à 10 secondes.
--
-- Ces quatre index ont DÉJÀ été créés à la main sur la production, sans bloquer
-- les écritures (CREATE INDEX CONCURRENTLY, 14/11 à 21 h 59 UTC). Cette
-- migration les consigne dans l'historique : rejouable, elle ne fait rien là où
-- ils existent (IF NOT EXISTS) et les crée partout ailleurs (base de test,
-- reconstruction). Les tables comptent moins de 30 000 lignes : la construction
-- prend moins d'une seconde.
--
-- Aucune donnée n'est modifiée.

CREATE INDEX IF NOT EXISTS "OrderItem_order_id_idx"   ON "OrderItem" ("order_id");
CREATE INDEX IF NOT EXISTS "OrderItem_dish_id_idx"    ON "OrderItem" ("dish_id");
CREATE INDEX IF NOT EXISTS "Paiement_order_id_idx"    ON "Paiement"  ("order_id");
CREATE INDEX IF NOT EXISTS "Address_customer_id_idx"  ON "Address"   ("customer_id");
