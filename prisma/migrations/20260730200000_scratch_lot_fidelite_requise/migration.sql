-- FIDÉLITÉ REQUISE sur les lots Gratte & Gagne (décision 30/07) : les CADEAUX
-- exigent un client un peu récurrent — au moins `min_paid_orders` commandes
-- payées OU `min_revenue` FCFA de CA net cumulé sur la fenêtre d'éligibilité
-- (`scratch.eligibility_window_days`, défaut 90 j). L'UN des deux critères
-- suffit ; 0 = critère inactif. Additif et idempotent.

ALTER TABLE "ScratchLot"
  ADD COLUMN IF NOT EXISTS "min_paid_orders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "min_revenue"     INTEGER NOT NULL DEFAULT 0;
