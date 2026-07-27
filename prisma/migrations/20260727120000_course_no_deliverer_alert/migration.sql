-- Relance + alerte quand aucun livreur n'est disponible pour une Course.
-- Avant : la course passait EXPIRED en silence (aucune relance, aucune alerte)
-- → commande prête que personne ne voit. Désormais elle reste
-- PENDING_ASSIGNMENT, le cron re-cherche un livreur, et le staff est alerté
-- une seule fois (horodatage ci-dessous).
--
-- Additif + idempotent.

ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "no_deliverer_alerted_at" TIMESTAMP(6);

-- Le cron de relance balaie les courses en attente d'affectation par ancienneté.
CREATE INDEX IF NOT EXISTS "Course_statut_created_at_idx"
  ON "Course" ("statut", "created_at");
