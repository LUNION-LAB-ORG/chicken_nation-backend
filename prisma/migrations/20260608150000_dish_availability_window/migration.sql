-- =====================================================================================
-- Créneau horaire de disponibilité du plat (available_from / available_until).
--
-- ADDITIF + IDEMPOTENT (aucune perte de données) :
--  - 2 colonnes nullable « HH:mm » sur Dish.
--  - NULL = plat toujours disponible (aucun changement de comportement existant).
-- =====================================================================================

ALTER TABLE "Dish" ADD COLUMN IF NOT EXISTS "available_from"  VARCHAR;
ALTER TABLE "Dish" ADD COLUMN IF NOT EXISTS "available_until" VARCHAR;
