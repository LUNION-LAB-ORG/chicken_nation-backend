-- Offre close par le serveur, SANS pénalité pour le livreur.
--
-- Une offre en attente est close quand le livreur se met en pause ou se
-- déconnecte, ou quand sa course est fusionnée, confiée à Turbo, annulée ou
-- n'est plus en recherche. Jusqu'ici elle restait en attente et finissait
-- « expirée », avec une pénalité injuste et une course bloquée deux minutes.
--
-- Seule dans sa migration : PostgreSQL refuse d'employer une valeur d'enum
-- dans la transaction qui la crée. Additive et rejouable.
ALTER TYPE "CourseOfferStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
