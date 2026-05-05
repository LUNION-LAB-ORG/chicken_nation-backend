-- Migration ciblée (pattern Neon, pas de drift).
--
-- Phase 1 de la refonte "grouping intelligent + assignation intelligente" :
-- on ajoute sur Deliverer les colonnes nécessaires pour
--   1. La géolocalisation temps réel (lat, lng, vitesse, direction)
--   2. La file d'attente FIFO (last_available_at + pauses)
--   3. Les pénalités post-refus (queue_penalty_until + positions + historique)
--
-- Toutes les colonnes sont nullable → migration non-bloquante pour la DB existante.

-- ── Géolocalisation ──────────────────────────────────────────────────────
ALTER TABLE "Deliverer"
  ADD COLUMN IF NOT EXISTS "last_location"    JSONB,
  ADD COLUMN IF NOT EXISTS "last_location_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "last_speed_kmh"   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "last_heading_deg" DOUBLE PRECISION;

-- ── File d'attente FIFO ──────────────────────────────────────────────────
ALTER TABLE "Deliverer"
  ADD COLUMN IF NOT EXISTS "last_available_at" TIMESTAMP(6);

-- ── Pauses (manuelle + forcée) ───────────────────────────────────────────
ALTER TABLE "Deliverer"
  ADD COLUMN IF NOT EXISTS "pause_until"      TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "auto_pause_until" TIMESTAMP(6);

-- ── Pénalités de queue post-refus ────────────────────────────────────────
ALTER TABLE "Deliverer"
  ADD COLUMN IF NOT EXISTS "queue_penalty_until"     TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "queue_penalty_positions" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "recent_refusals"         JSONB;

-- ── Index pour tris rapides en queue ─────────────────────────────────────
-- Utilisé par DelivererScoringService.rankCandidates() qui trie
-- `ORDER BY last_available_at ASC` sur les livreurs éligibles.
CREATE INDEX IF NOT EXISTS "Deliverer_last_available_at_idx"
  ON "Deliverer" ("last_available_at");

CREATE INDEX IF NOT EXISTS "Deliverer_pause_until_idx"
  ON "Deliverer" ("pause_until");

CREATE INDEX IF NOT EXISTS "Deliverer_auto_pause_until_idx"
  ON "Deliverer" ("auto_pause_until");
