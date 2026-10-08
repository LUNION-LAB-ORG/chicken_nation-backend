-- Marqueur de l'alerte « commande terminée sans paiement ».
--
-- L'alerte ne part plus à l'instant du changement de statut mais 90 minutes
-- après : le paiement arrive parfois bien après la fin de la commande (un cas
-- mesuré en production montrait 1 h 00 min 15 s d'écart), et le groupe
-- recevait des impayés qui n'en étaient pas.
--
-- Non nul = alerte déjà postée. Remis à NULL quand le paiement arrive, en même
-- temps que le message de régularisation.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "alerte_impaye_at" TIMESTAMP(6);

-- Les deux passages de la tâche cherchent sur ce champ, parmi des commandes
-- terminées : sans index, ils balaieraient toute la table toutes les 10 min.
CREATE INDEX IF NOT EXISTS "Order_alerte_impaye_at_idx" ON "Order" ("alerte_impaye_at");
