-- =====================================================================================
-- Type de commande disponible (available_order_types) sur Dish et Supplement.
--
-- ADDITIF + IDEMPOTENT (aucune perte de données) :
--  - nouvelle colonne tableau d'enum "OrderType"[] sur Dish et Supplement
--  - défaut = [DELIVERY, PICKUP, TABLE] → les lignes existantes restent disponibles
--    pour TOUS les modes (aucun changement de comportement).
-- =====================================================================================

ALTER TABLE "Dish"
  ADD COLUMN IF NOT EXISTS "available_order_types" "OrderType"[]
  NOT NULL DEFAULT ARRAY['DELIVERY', 'PICKUP', 'TABLE']::"OrderType"[];

ALTER TABLE "Supplement"
  ADD COLUMN IF NOT EXISTS "available_order_types" "OrderType"[]
  NOT NULL DEFAULT ARRAY['DELIVERY', 'PICKUP', 'TABLE']::"OrderType"[];
