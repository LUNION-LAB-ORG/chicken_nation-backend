-- Bascule automatique vers la flotte externe Turbo quand la flotte interne est
-- saturée (aucun livreur du Store disponible pendant N minutes).
-- Turbo applique lui-même sa règle BIRD (rayon 3-5 km, score) puis ASSIGNÉ.
--
-- Additif + idempotent.

ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "turbo_escalated_at" TIMESTAMP(6);
