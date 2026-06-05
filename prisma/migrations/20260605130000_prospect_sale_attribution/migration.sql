-- Attribution de la 1ʳᵉ vente directe d'un prospect (dénormalisé pour les
-- statistiques « Ventes générées » et le CA). Rempli par le listener order:created.
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "first_order_id" UUID;
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "first_order_amount" DOUBLE PRECISION;
-- Horodatage du 1er appel « joint » (entonnoir « vérifiés »).
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "joined_at" TIMESTAMP(3);
