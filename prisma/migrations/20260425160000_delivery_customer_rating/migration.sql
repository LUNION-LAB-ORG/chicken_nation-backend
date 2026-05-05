-- Migration ciblée (pattern Neon, pas de drift).
--
-- Notation du client par le livreur (post-livraison) — feature P-rate.
-- Le livreur ouvre l'écran "Noter le client" après avoir livré (ou échoué)
-- une livraison, donne 1-5 étoiles + un message libre. Utilisé par les ops
-- pour identifier les clients problématiques (agressivité, fraude, adresse
-- fausse, etc.).
--
-- 3 colonnes ajoutées + 1 index :
--   1. customer_rating       INT   (SmallInt 1-5, nullable)
--   2. customer_rating_note  VARCHAR(500) (note libre, nullable)
--   3. customer_rated_at     TIMESTAMP    (audit timestamp)
--   4. INDEX (customer_rating) pour stats ops

-- ── Colonnes : ajout idempotent ──────────────────────────────────────────
ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "customer_rating" SMALLINT;

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "customer_rating_note" VARCHAR(500);

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "customer_rated_at" TIMESTAMP(6);

-- ── Index pour stats ops ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Delivery_customer_rating_idx"
  ON "Delivery" ("customer_rating");
