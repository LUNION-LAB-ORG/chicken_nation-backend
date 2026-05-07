-- Migration ciblée (pattern Neon, pas de drift).
--
-- 1. Ajoute la valeur CHICKEN_NATION à l'enum DeliveryService
-- 2. Ajoute la colonne at_restaurant_at sur Course (trace arrivée livreur avant pickup)

-- 1) Enum DeliveryService : ajouter CHICKEN_NATION (FREE conservé pour compat historique)
ALTER TYPE "DeliveryService" ADD VALUE IF NOT EXISTS 'CHICKEN_NATION';

-- 2) Course : nouvelle colonne at_restaurant_at (nullable, pas de backfill nécessaire)
ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "at_restaurant_at" TIMESTAMP(6);
