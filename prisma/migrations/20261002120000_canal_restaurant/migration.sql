-- CANAL « RESTAURANT » (02/10/2026).
--
-- Le canal des commandes (migration 20261002100000) ne connaissait que
-- l'application, le site et le centre d'appels. Une vente saisie au comptoir
-- par un caissier (compte de type RESTAURANT, route POST /orders/create)
-- était donc enregistrée CALL_CENTER, et un rapport par canal aurait compté
-- les ventes des restaurants comme des appels.
--
-- Nouvelle migration plutôt qu'une retouche de la précédente, qui a pu être
-- déjà appliquée. Additive et rejouable.

ALTER TYPE "OrderChannel" ADD VALUE IF NOT EXISTS 'RESTAURANT';

-- Pas de reprise ici : PostgreSQL refuse d'employer une valeur d'enum dans la
-- transaction qui l'ajoute, et Prisma passe chaque migration d'un seul bloc.
-- Si des commandes de comptoir ont été créées entre le déploiement de
-- 20261002100000 et celui-ci, les reprendre APRÈS le déploiement, à la main :
--
--   UPDATE "Order" o SET channel = 'RESTAURANT'
--   FROM "User" u
--   WHERE o.user_id = u.id AND u.type = 'RESTAURANT' AND o.channel = 'CALL_CENTER';
