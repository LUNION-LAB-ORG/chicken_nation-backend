-- BONUS DE PALIER RÉGLABLES + suppression du bonus d'entrée (décision 31/07).
--
-- STANDARD est le niveau d'ENTRÉE depuis le 23/07 : son bonus (100 pts, codé
-- en dur) tombait dès la 1re commande, soit l'équivalent de 50 000 F d'achats
-- offerts à l'inscription — et il était exploitable par annulation (incident
-- du 31/07). Il passe à 0 ; VIP et VVIP récompensent une vraie progression et
-- gardent le leur. Les trois montants deviennent réglables au backoffice.
-- Additif et idempotent.

ALTER TABLE "LoyaltyConfig"
  ADD COLUMN IF NOT EXISTS "bonus_standard" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bonus_vip"      INTEGER NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS "bonus_vvip"     INTEGER NOT NULL DEFAULT 200;

-- Configurations DÉJÀ créées : on force le bonus d'entrée à 0 (le défaut de
-- colonne ne s'applique qu'aux nouvelles lignes).
UPDATE "LoyaltyConfig" SET "bonus_standard" = 0 WHERE "bonus_standard" <> 0;
