-- ============================================================
-- Migration : ajout de la relation Order ↔ Deliverer
-- Date       : 2026-04-21
-- Ciblée     : 1 colonne + 1 FK + 1 index sur la table Order
-- Aucune autre table n'est touchée.
--
-- onDelete: SetNull → si le livreur est supprimé/anonymisé, la course garde
-- son historique mais perd la référence au livreur (préservation FK).
-- ============================================================

-- AddColumn
ALTER TABLE "Order" ADD COLUMN "deliverer_id" UUID;

-- CreateIndex (utile pour "GET orders where deliverer_id = X")
CREATE INDEX "Order_deliverer_id_idx" ON "Order"("deliverer_id");

-- AddForeignKey
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_deliverer_id_fkey"
  FOREIGN KEY ("deliverer_id")
  REFERENCES "Deliverer"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
