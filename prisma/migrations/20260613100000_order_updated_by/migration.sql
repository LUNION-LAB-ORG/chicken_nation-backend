-- Audit backoffice : dernier membre du staff ayant modifié la commande.
-- ADDITIF + IDEMPOTENT, nullable (aucune perte de données).
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "updated_by" UUID;
