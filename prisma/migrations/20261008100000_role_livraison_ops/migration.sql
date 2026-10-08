-- Nouveau rôle LIVRAISON_OPS : suivi des commandes en consultation seule.
--
-- Additive et rejouable. Aucune reprise de données ici : PostgreSQL refuse
-- d'employer une valeur d'enum dans la transaction qui la crée, et de toute
-- façon aucun compte existant ne prend ce rôle.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'LIVRAISON_OPS';
