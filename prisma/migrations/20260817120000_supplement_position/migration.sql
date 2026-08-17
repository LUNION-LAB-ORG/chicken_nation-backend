-- ORDRE D'AFFICHAGE DES SUPPLÉMENTS (17/08).
--
-- Jusqu'ici les suppléments sortaient par ordre alphabétique, ce qui n'a aucun
-- rapport avec ce qu'on veut mettre en avant : les glaces passaient avant les
-- sodas parce que « G » vient avant « S ».
--
-- Additive. Le rattrapage recopie l'ordre alphabétique ACTUEL dans la nouvelle
-- colonne, catégorie par catégorie : au déploiement, rien ne bouge à l'écran.
-- Le gestionnaire réordonne ensuite ce qu'il veut, quand il veut.

ALTER TABLE "Supplement" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;

WITH ordre AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "category" ORDER BY "name" ASC) AS rang
  FROM "Supplement"
)
UPDATE "Supplement" s
SET "position" = ordre.rang
FROM ordre
WHERE s."id" = ordre."id" AND s."position" = 0;

CREATE INDEX IF NOT EXISTS "Supplement_category_position_idx" ON "Supplement"("category", "position");
