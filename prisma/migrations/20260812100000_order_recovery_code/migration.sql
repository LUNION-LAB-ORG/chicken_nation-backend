-- CODE DE RÉCUPÉRATION (12/08).
--
-- Quatre chiffres remis au client, qu'il présente pour récupérer sa commande :
-- dicté au livreur à la remise, ou donné au comptoir pour un retrait.
--
-- Porté par la COMMANDE plutôt que par la livraison : il existe dès la création,
-- il vaut pour tous les modes de commande, et il reste unique puisque
-- `Delivery.delivery_pin` en reçoit désormais une copie au lieu d'un tirage
-- indépendant. Sans cela le client se retrouvait avec deux codes différents.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "recovery_code" VARCHAR;

-- Rattrapage des commandes EN COURS. Une commande déjà terminée ou annulée n'a
-- plus rien à faire récupérer, inutile de lui inventer un code.
--
-- Les livraisons déjà lancées gardent leur code : on recopie `delivery_pin`
-- quand il existe, pour que le client qui l'a déjà reçu ne voie pas le sien
-- changer sous ses yeux. Les autres reçoivent un tirage à quatre chiffres.
UPDATE "Order" o
SET "recovery_code" = COALESCE(
  (SELECT d."delivery_pin" FROM "Delivery" d WHERE d."order_id" = o."id" AND d."delivery_pin" IS NOT NULL LIMIT 1),
  LPAD((FLOOR(RANDOM() * 10000))::INT::TEXT, 4, '0')
)
WHERE o."recovery_code" IS NULL
  AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'COLLECTED');
