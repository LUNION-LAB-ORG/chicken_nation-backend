-- MENUS COMPOSABLES (10/08) — modèle d'options.
--
-- Huit burgers qui ne diffèrent que par la sauce deviennent UN burger dont le
-- client compose la recette. Cette migration pose seulement la structure : elle
-- ne touche à aucun plat existant et ne change aucun prix.
--
-- Strictement additive et rejouable :
--   - `Dish.composable` arrive à FALSE, donc tout le catalogue actuel se
--     comporte exactement comme avant ;
--   - un plat composable est invisible de toutes les applications tant que le
--     verrou côté serveur n'est pas levé version par version.

ALTER TABLE "Dish" ADD COLUMN IF NOT EXISTS "composable" BOOLEAN NOT NULL DEFAULT false;

-- Un GROUPE d'options : « Choix de sauce », « Format », « Épicé ou non ».
-- La contrainte de sélection vit sur le groupe, pas sur le choix.
CREATE TABLE IF NOT EXISTS "DishOptionGroup" (
    "id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" VARCHAR,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "min_select" INTEGER NOT NULL DEFAULT 1,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DishOptionGroup_pkey" PRIMARY KEY ("id")
);

-- Un CHOIX dans un groupe. Le prix vit ici, donc il dépend du plat : le format
-- « Menu » ne coûte pas la même chose sur un burger et sur un poulet pané.
CREATE TABLE IF NOT EXISTS "DishOptionItem" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "label" VARCHAR NOT NULL,
    "price_delta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supplement_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DishOptionItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DishOptionGroup_dish_id_position_idx" ON "DishOptionGroup"("dish_id", "position");
CREATE INDEX IF NOT EXISTS "DishOptionItem_group_id_position_idx" ON "DishOptionItem"("group_id", "position");

-- Suppression en cascade du plat vers ses groupes, et du groupe vers ses choix :
-- une configuration orpheline n'a aucun sens et fausserait les additions.
-- Le rattachement au catalogue de suppléments reste souple (SET NULL) : retirer
-- un supplément du catalogue ne doit pas faire disparaître le choix « Mayonnaise »
-- d'un burger déjà configuré.
DO $$
BEGIN
    ALTER TABLE "DishOptionGroup" ADD CONSTRAINT "DishOptionGroup_dish_id_fkey"
        FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "DishOptionItem" ADD CONSTRAINT "DishOptionItem_group_id_fkey"
        FOREIGN KEY ("group_id") REFERENCES "DishOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "DishOptionItem" ADD CONSTRAINT "DishOptionItem_supplement_id_fkey"
        FOREIGN KEY ("supplement_id") REFERENCES "Supplement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
