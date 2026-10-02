-- POINTS RENDUS (03/10/2026).
--
-- Quand une commande payée avec des points est annulée, le serveur rend ces
-- points au client. Depuis le 02/10, il le faisait en passant la ligne de
-- retrait (REDEEMED) en EXPIRED et en créant un crédit BONUS sans commande :
-- dans l'historique (application, back office), la dépense apparaissait
-- « expirée » et le remboursement « bonus ».
--
-- Nouveau type REFUNDED : une ligne de +points rattachée à la commande, la
-- ligne de retrait restant intacte. Ces points se dépensent et expirent comme
-- les autres, mais ne comptent ni pour le niveau ni pour lifetime_points.
--
-- Additive et rejouable. PostgreSQL refuse d'employer une valeur d'enum dans
-- la transaction qui l'ajoute, et Prisma passe chaque migration d'un seul
-- bloc : la reprise des remboursements déjà faits est dans la migration
-- suivante, 20261003090100_points_rendus_reprise.

ALTER TYPE "LoyaltyPointType" ADD VALUE IF NOT EXISTS 'REFUNDED';
