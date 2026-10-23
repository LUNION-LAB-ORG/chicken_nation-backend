-- Commandes à livrer, lues par le planificateur v2 toutes les 10 s, nuit
-- comprise (restaurants actifs, instantané d'un restaurant, repli v1) : filtre
-- sur le statut (prête, en cuisine) et la date de mise à jour. Sans index,
-- chaque passage lisait toute la table des commandes.
--
-- Additive et rejouable. Même nom que celui que Prisma donne à
-- `@@index([status, updated_at])`.
CREATE INDEX IF NOT EXISTS "Order_status_updated_at_idx" ON "Order"("status", "updated_at");
