-- Une catégorie peut devenir la VITRINE des promotions : elle rassemble d'
-- elle-même les plats en promotion, sans qu'on ait à les y déplacer. Aucun plat
-- ne change de catégorie, c'est la lecture qui s'élargit.
ALTER TABLE "Category"
  ADD COLUMN "auto_promotions" BOOLEAN NOT NULL DEFAULT false;

-- La catégorie « PROMOTIONS » déjà en place devient la vitrine, pour que le
-- comportement soit acquis dès le déploiement sans manipulation.
-- Volontairement ancré sur le début du nom : « PROMOTIONS », « PROMOTION »,
-- « Promotions du moment » sont pris, une catégorie « Menus promo » ne l'est
-- pas et reste à cocher à la main.
UPDATE "Category"
SET "auto_promotions" = true
WHERE "entity_status" = 'ACTIVE'
  AND upper("name") LIKE 'PROMOTION%';
