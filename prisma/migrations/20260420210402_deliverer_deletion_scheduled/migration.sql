-- ============================================================
-- Migration : ajout de la suppression différée (RGPD + période de grâce)
-- Date       : 2026-04-20
-- Ciblée     : 1 colonne + 1 index sur la table Deliverer
-- Aucune autre table n'est touchée (safe pour données existantes)
-- ============================================================

-- AddColumn
ALTER TABLE "Deliverer" ADD COLUMN "deletion_scheduled_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "Deliverer_deletion_scheduled_at_idx" ON "Deliverer"("deletion_scheduled_at");
