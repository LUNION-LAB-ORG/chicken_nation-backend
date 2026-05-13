-- Migration ciblée (pattern Neon, pas de drift).
--
-- Ajoute le ciblage par plats/catégories aux codes promo, pour atteindre
-- la parité avec le module Promotion qui supportait déjà ce ciblage.
--
-- Schéma symétrique à PromotionTargetedDish / PromotionTargetedCategory :
--   - colonne `target_type` (TargetType enum) sur PromoCode, défaut ALL_PRODUCTS
--     -> rétro-compatible : tous les codes existants restent ALL_PRODUCTS
--   - tables de liaison PromoCodeTargetedDish / PromoCodeTargetedCategory
--     avec @@unique et ON DELETE CASCADE des deux côtés.
--
-- Aucune donnée existante n'est modifiée hormis l'ajout de target_type
-- avec sa valeur par défaut.

-- 1. Ajouter la colonne target_type avec valeur par défaut ALL_PRODUCTS
ALTER TABLE "PromoCode"
  ADD COLUMN "target_type" "TargetType" NOT NULL DEFAULT 'ALL_PRODUCTS';

-- 2. Table de liaison PromoCode <-> Dish
CREATE TABLE "PromoCodeTargetedDish" (
    "id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,

    CONSTRAINT "PromoCodeTargetedDish_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoCodeTargetedDish_promo_code_id_dish_id_key"
  ON "PromoCodeTargetedDish"("promo_code_id", "dish_id");

ALTER TABLE "PromoCodeTargetedDish"
  ADD CONSTRAINT "PromoCodeTargetedDish_promo_code_id_fkey"
  FOREIGN KEY ("promo_code_id") REFERENCES "PromoCode"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoCodeTargetedDish"
  ADD CONSTRAINT "PromoCodeTargetedDish_dish_id_fkey"
  FOREIGN KEY ("dish_id") REFERENCES "Dish"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Table de liaison PromoCode <-> Category
CREATE TABLE "PromoCodeTargetedCategory" (
    "id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "PromoCodeTargetedCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoCodeTargetedCategory_promo_code_id_category_id_key"
  ON "PromoCodeTargetedCategory"("promo_code_id", "category_id");

ALTER TABLE "PromoCodeTargetedCategory"
  ADD CONSTRAINT "PromoCodeTargetedCategory_promo_code_id_fkey"
  FOREIGN KEY ("promo_code_id") REFERENCES "PromoCode"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoCodeTargetedCategory"
  ADD CONSTRAINT "PromoCodeTargetedCategory_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "Category"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
