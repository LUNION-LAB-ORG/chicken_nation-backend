-- =====================================================================================
-- Bascule "inclusion -> exclusion" pour les liens Plat<->Supplément et Plat<->Restaurant.
--
-- Approche (validée) : on RÉUTILISE les 2 tables existantes en les RENOMMANT (pas de
-- nouvelles tables), puis on les VIDE pour démarrer "tout par défaut, zéro exclusion".
-- Désormais : un plat propose TOUS les suppléments / est vendu dans TOUS les restaurants,
-- SAUF les lignes présentes dans ces tables (les exclusions, à gérer ensuite).
--
-- ⚠️ Données : on SUPPRIME les liens plat<->supplément/restaurant actuels (config menu,
-- pas les commandes/clients). À tester sur une BRANCHE Neon avant la prod.
-- Idempotent : ALTER ... IF EXISTS + CREATE INDEX IF NOT EXISTS.
-- =====================================================================================

-- 1) Renommer les tables existantes -> sémantique "exclusion"
ALTER TABLE IF EXISTS "DishSupplement" RENAME TO "DishExcludedSupplement";
ALTER TABLE IF EXISTS "DishRestaurant" RENAME TO "DishExcludedRestaurant";

-- 2) Vider : on repart "tout par défaut, aucune exclusion"
DELETE FROM "DishExcludedSupplement";
DELETE FROM "DishExcludedRestaurant";

-- 3) Unicité (empêche les exclusions en double)
CREATE UNIQUE INDEX IF NOT EXISTS "DishExcludedSupplement_dish_id_supplement_id_key"
    ON "DishExcludedSupplement" ("dish_id", "supplement_id");

CREATE UNIQUE INDEX IF NOT EXISTS "DishExcludedRestaurant_dish_id_restaurant_id_key"
    ON "DishExcludedRestaurant" ("dish_id", "restaurant_id");
