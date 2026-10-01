-- COMMANDES REPRISES PAR LE PERSONNEL restées en paiement en ligne.
--
-- Depuis le 30/09, l'écran « Modifier la commande » fait passer une commande
-- de l'application au call center (taxe à zéro, acceptée). Le moyen de
-- paiement, lui, restait « en ligne » : la caisse n'ouvre son formulaire
-- d'encaissement qu'aux commandes payées au restaurant, et les caissières ne
-- pouvaient plus enregistrer le paiement. Le serveur pose désormais le
-- paiement au restaurant à la reprise ; cette migration répare les commandes
-- reprises avant le correctif.
--
-- Périmètre volontairement étroit :
--  - commande du personnel, en ligne, non payée ;
--  - hors HubRise (commandes légitimement en ligne, toutes payées) ;
--  - active, dans un statut de l'écran d'opérations, terminée comprise
--    (c'est là que la caissière encaisse l'argent rapporté par le livreur).
--    Les commandes en attente ou annulées ne sont pas touchées ;
--  - modifiée depuis le 30/09 : toute commande reprise l'a été depuis cette
--    date, et les anciennes commandes du centre d'appels nées en ligne avant
--    février 2026 restent intactes ;
--  - il reste à payer : les paiements réussis (un paiement en ligne
--    partiel, par exemple) ne couvrent pas le total, à la tolérance de 50 F
--    près. La caisse n'encaisse que le reste ;
--  - aucun encaissement de livreur en attente : il se confirme déjà depuis
--    l'onglet Paiement. Ce cas se vérifie à la main.
--
-- Même règle que le serveur (`OrderService.update`) : une commande reprise
-- avant ou après le déploiement atterrit dans le même état.
--
-- Rejouable : une commande réparée n'est plus en ligne et sort d'elle même du
-- filtre. Aucun déclencheur sur "Order" (crm_suivre_passage est sur
-- "CrmContact"). "updated_at" n'est volontairement pas modifié.
-- Chaque commande réparée laisse une ligne dans le journal d'audit.

WITH reprises AS (
  UPDATE "Order" o
     SET "payment_method" = 'OFFLINE'
   WHERE o."auto" = false
     AND o."payment_method" = 'ONLINE'
     AND o."paied" = false
     AND o."hubrise_order_id" IS NULL
     AND o."entity_status" = 'ACTIVE'
     AND o."status" IN ('ACCEPTED', 'IN_PROGRESS', 'READY', 'PICKED_UP', 'COLLECTED', 'COMPLETED')
     AND o."updated_at" >= TIMESTAMP '2026-09-30 00:00:00'
     AND NOT EXISTS (
       SELECT 1 FROM "Paiement" p
        WHERE p."order_id" = o."id"
          AND p."status" = 'PENDING'
     )
     AND (
       SELECT COALESCE(SUM(COALESCE(p."total", p."amount", 0)), 0)
         FROM "Paiement" p
        WHERE p."order_id" = o."id"
          AND p."status" = 'SUCCESS'
     ) < o."amount" - 50
  RETURNING o."id", o."reference", o."restaurant_id"
)
-- "id" fourni explicitement, comme dans les autres migrations du dépôt : le
-- défaut SQL de la colonne n'est pas déclaré dans le schéma Prisma, et ne
-- doit pas être une condition de réussite.
INSERT INTO "audit_logs" ("id", "action", "module", "entity_id", "method", "path", "summary", "metadata", "restaurant_id")
SELECT gen_random_uuid(),
       'UPDATE',
       'orders',
       r."id"::text,
       'SQL',
       'migration 20261001120000_commandes_basculees_paiement_caisse',
       'Paiement à la caisse : commande reprise par le personnel',
       jsonb_build_object(
         'reference', r."reference",
         'payment_method_avant', 'ONLINE',
         'payment_method_apres', 'OFFLINE'
       ),
       r."restaurant_id"
  FROM reprises r;
