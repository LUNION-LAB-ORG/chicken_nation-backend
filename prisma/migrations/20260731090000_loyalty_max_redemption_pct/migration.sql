-- PLAFOND ANTI-ABUS sur la remise fidélité (incident du 31/07) : une cliente a
-- payé une commande, encaissé le bonus de palier d'entrée (100 pts), annulé sa
-- commande — puis dépensé ces points offerts sur une nouvelle commande, réglée
-- 650 F au lieu de 2 000 F, livraison gratuite comprise.
--
-- Deux verrous posés : le bonus de palier est désormais RATTACHÉ à la commande
-- qui l'a déclenché (donc révoqué avec elle), et la remise fidélité ne peut
-- plus couvrir plus de `max_redemption_pct` % du panier (défaut 50 %).
-- 100 = pas de plafond. Additif et idempotent.

ALTER TABLE "LoyaltyConfig"
  ADD COLUMN IF NOT EXISTS "max_redemption_pct" INTEGER NOT NULL DEFAULT 50;
