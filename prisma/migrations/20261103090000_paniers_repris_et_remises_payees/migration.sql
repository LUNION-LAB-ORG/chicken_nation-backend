-- Commandes : dates des paniers rattrapés, et commandes « Récupérées » déjà payées (03/11).
--
-- POURQUOI
-- 1. Un panier repris au téléphone depuis « À relancer » gardait comme date de
--    création celle du panier. Les statistiques comptaient tout le temps passé
--    dans « À relancer » comme « Attente acceptation », et rangeaient la
--    commande à l'heure du panier. Le code donne désormais à la commande la
--    date de la reprise (la date du panier reste dans submitted_at), comme pour
--    un paiement en ligne différé. Ici : les reprises déjà faites.
-- 2. Une commande encaissée AVANT d'être remise au client restait « Récupérée »
--    pour toujours : l'encaissement ne termine que ce qui est déjà récupéré, et
--    la remise ne regardait pas le paiement. Le code la termine désormais. Ici :
--    celles qui sont restées bloquées.
--
-- PÉRIMÈTRE
-- 1. Commandes dont le journal de la relance porte une REPRISE (écrite depuis le
--    01/10, seulement pour un panier non payé), créées plus d'une minute avant
--    cette reprise : created_at = date de la reprise, submitted_at = date du
--    panier si elle n'était pas déjà gardée. Une commande dont la date a déjà
--    été déplacée après la reprise (paiement en ligne) n'est pas touchée.
-- 2. Commandes actives au statut COLLECTED et payées : COMPLETED, terminée à la
--    plus tardive de la remise et du paiement. Aucune notification ne part (ni
--    cloche, ni « Merci » au client) : ce sont des commandes passées.
--
-- Rejouable : chaque partie ne retrouve plus rien une fois passée.
-- Aucune table ni colonne touchée ; aucun déclencheur sur "Order".
--
-- MESURE AVANT (lecture seule, à lancer dans Neon avant le déploiement) :
--   SELECT count(*) AS paniers_repris_a_redater
--   FROM "Order" o
--   JOIN (SELECT order_id, MIN(created_at) AS repris_le FROM "OrderRelanceJournal"
--         WHERE action = 'REPRISE' GROUP BY order_id) r ON r.order_id = o.id
--   WHERE o.created_at < r.repris_le - interval '1 minute';
--
--   SELECT type, auto, count(*) AS recuperees_payees, sum(amount) AS montant
--   FROM "Order" WHERE status = 'COLLECTED' AND paied = true AND entity_status <> 'DELETED'
--   GROUP BY type, auto;
--
-- CONTRÔLE APRÈS : les deux requêtes ci-dessus rendent 0 ligne / 0.

-- 1. Paniers rattrapés : la commande naît à la reprise.
WITH reprises AS (
  SELECT order_id, MIN(created_at) AS repris_le
  FROM "OrderRelanceJournal"
  WHERE action = 'REPRISE'
  GROUP BY order_id
)
UPDATE "Order" o
SET submitted_at = COALESCE(o.submitted_at, o.created_at),
    created_at = r.repris_le
FROM reprises r
WHERE o.id = r.order_id
  AND o.created_at < r.repris_le - interval '1 minute';

-- 2. Récupérées et payées : terminées.
UPDATE "Order"
SET status = 'COMPLETED',
    completed_at = COALESCE(GREATEST(collected_at, paied_at), updated_at),
    updated_at = now()
WHERE status = 'COLLECTED'
  AND paied = true
  AND entity_status <> 'DELETED';
