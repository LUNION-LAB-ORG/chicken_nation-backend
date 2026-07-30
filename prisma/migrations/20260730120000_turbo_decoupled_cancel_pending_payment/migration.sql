-- Découplage annulation Turbo + encaissement à la livraison.
--
-- 1. `PaiementStatus.PENDING` : encaissement déclaré par un livreur (Turbo)
--    mais pas encore confirmé par le backoffice. La commande reste COLLECTED
--    tant qu'un humain n'a pas validé — la confirmation passe le paiement en
--    SUCCESS et termine la commande (cascade addPaiement existante).
-- 2. `Delivery.turbo_cancelled_reason` : raison transmise par Turbo quand ILS
--    annulent une course. Depuis le découplage, l'annulation Turbo n'annule
--    plus la commande CN — seule la course/livraison est annulée, et la raison
--    est affichée au staff (drawer + détail commande).
--
-- Additif et idempotent : rejouable sans effet sur les deux backends.

ALTER TYPE "PaiementStatus" ADD VALUE IF NOT EXISTS 'PENDING';

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "turbo_cancelled_reason" VARCHAR(500);
