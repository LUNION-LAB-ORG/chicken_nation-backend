-- Offres de livraison : ciblage des étudiants, menus et catégories concernés.
-- Additive : les offres existantes gardent leur comportement (ni étudiant ni
-- menu choisi = tous les clients, tout le menu).
ALTER TABLE "DeliveryOffer"
  ADD COLUMN "target_etudiant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dish_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "category_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
