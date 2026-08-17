-- Nouveau type d'offre : prix de livraison IMPOSÉ.
--
-- Les trois types existants sont des REMISES appliquées au frais calculé.
-- Celui-ci REMPLACE le frais : « toutes les livraisons à 1000 F », ou par
-- paliers de distance. Au-delà du dernier palier, la livraison retombe sur le
-- système habituel (grille Chicken ou zones Turbo selon le paramétrage).
ALTER TYPE "DeliveryOfferType" ADD VALUE IF NOT EXISTS 'FIXED_PRICE';

-- Paliers de prix par distance, propres à FIXED_PRICE.
-- [{ "max_km": 2, "price": 1000 }, { "max_km": 5, "price": 1500 }]
ALTER TABLE "DeliveryOffer" ADD COLUMN IF NOT EXISTS "price_tiers" JSON;
