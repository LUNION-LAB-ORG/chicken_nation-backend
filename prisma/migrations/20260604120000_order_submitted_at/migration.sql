-- Paiements différés : un client crée une commande un jour et la paie un autre jour.
-- Désormais `created_at` est aligné sur l'instant du PAIEMENT (la commande remonte en
-- tête de liste et tombe dans la bonne période de filtrage). On conserve ici l'instant
-- de soumission initiale afin de ne RIEN perdre.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMP(6);
