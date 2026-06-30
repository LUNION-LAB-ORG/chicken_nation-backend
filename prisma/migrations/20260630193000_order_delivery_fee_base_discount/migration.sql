-- Bilan livraison : tracer sur chaque commande le frais de livraison PLEIN (avant offre)
-- + la remise de l'offre, calculés côté serveur. Permet le bilan sans jointure ni reconstruction.
-- Additif + idempotent (IF NOT EXISTS / WHERE = 0).

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "delivery_fee_base" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "delivery_discount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill historique :
--   remise = somme des usages d'offre de livraison ACTIFS rattachés à la commande ;
--   base (frais plein) = frais facturé + remise.
-- Reconstruit correctement les commandes dont l'offre a bien été tracée (livraison
-- gratuite via l'app). Pour les commandes sans usage tracé, base = frais facturé.
UPDATE "Order" o
SET "delivery_discount" = COALESCE((
  SELECT SUM(dou."discount_amount")
  FROM "DeliveryOfferUsage" dou
  WHERE dou."order_id" = o."id" AND dou."status" = 'ACTIVE'
), 0)
WHERE o."delivery_discount" = 0;

UPDATE "Order" o
SET "delivery_fee_base" = o."delivery_fee" + o."delivery_discount"
WHERE o."delivery_fee_base" = 0;
