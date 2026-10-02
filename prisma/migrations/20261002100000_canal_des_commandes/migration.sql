-- CANAL DES COMMANDES (02/10/2026).
--
-- La commande en ligne s'ouvre sur le site web. Jusqu'ici, seul le booléen
-- "auto" distinguait l'application du centre d'appels : une commande du site
-- aurait été comptée « Appli ». Le nouveau champ "channel" dit d'où vient
-- chaque commande créée à partir de maintenant.
--
-- Migration additive, sans reprise de l'historique : les commandes existantes
-- gardent "channel" vide et se lisent comme avant, avec "auto".

CREATE TYPE "OrderChannel" AS ENUM ('APP', 'WEB', 'CALL_CENTER');

ALTER TABLE "Order" ADD COLUMN "channel" "OrderChannel";
