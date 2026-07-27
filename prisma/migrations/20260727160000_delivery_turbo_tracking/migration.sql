-- Suivi COMPLET des livraisons sous-traitées à Turbo.
-- Une livraison confiée à la flotte externe doit être aussi bien suivie qu'une
-- livraison interne : qui livre, comment le joindre, et où il se trouve.
-- Dégroupage : 1 Delivery = 1 course Turbo (leur API prend 1 commande).
--
-- Additif + idempotent.

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "turbo_course_id"           VARCHAR,
  ADD COLUMN IF NOT EXISTS "turbo_courier_id"          VARCHAR,
  ADD COLUMN IF NOT EXISTS "turbo_courier_name"        VARCHAR,
  ADD COLUMN IF NOT EXISTS "turbo_courier_phone"       VARCHAR,
  ADD COLUMN IF NOT EXISTS "turbo_courier_lat"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "turbo_courier_lng"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "turbo_courier_location_at" TIMESTAMP(6);
