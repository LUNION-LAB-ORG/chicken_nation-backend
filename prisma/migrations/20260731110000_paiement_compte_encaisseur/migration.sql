-- MULTI-COMPTES KKiaPay (décision 31/07) : chaque restaurant encaisse sur SON
-- compte. On TRACE sur chaque paiement le compte qui a réellement encaissé
-- (id du restaurant, NULL = compte global historique) — indispensable pour
-- rembourser depuis le bon compte et réconcilier compte KKiaPay ↔ commandes.
-- Ce champ doit exister AVANT la première bascule. Additif et idempotent.

ALTER TABLE "Paiement"
  ADD COLUMN IF NOT EXISTS "restaurant_id" UUID;

CREATE INDEX IF NOT EXISTS "Paiement_restaurant_id_idx" ON "Paiement"("restaurant_id");
