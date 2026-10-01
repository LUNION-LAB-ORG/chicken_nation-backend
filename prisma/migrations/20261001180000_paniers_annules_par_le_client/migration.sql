-- PANIERS ANNULÉS PAR LE CLIENT restés actifs depuis le 30/09.
--
-- Le 30/09 (commit 1c42592), le panier de l'application que le client annule
-- avant de payer a cessé de passer DELETED : il restait ACTIVE au statut
-- CANCELLED, visible dans Commandes comme n'importe quelle annulation. Demande
-- du 01/10 : il repasse DELETED (hors de Commandes, En cours, statistiques et
-- CRM) et reste suivi dans « À relancer », avec le motif « Annulée par le
-- client ». Le serveur le fait désormais à l'annulation, avec la valeur
-- constante 'client' dans "cancelled_by" ; cette migration remet dans cet état
-- les paniers annulés entre le déploiement de 1c42592 et ce correctif.
--
-- Périmètre volontairement étroit, mêmes critères que le serveur :
--  - commande de l'application (auto), payable en ligne ;
--  - jamais payée : "paied" faux, "paied_at" nul, aucun paiement réussi ;
--  - annulée, jamais acceptée ("accepted_at" nul : annulée en attente) ;
--  - annulée PAR LE CLIENT : jusqu'ici la route du client écrivait
--    l'identifiant du client dans "cancelled_by" ; le personnel y écrit le
--    sien, une course 'turbo', 'deliverer' ou 'system'. La valeur 'client'
--    est acceptée aussi (rejouée après le déploiement du serveur) ;
--  - encore active ;
--  - annulée et modifiée depuis le 30/09 : les paniers plus anciens ont été
--    supprimés par l'ancien code, à l'annulation même.
--
-- Effet : "entity_status" DELETED, "deleted_at" = date d'annulation,
-- "cancelled_by" = 'client' (marqueur lu par la relance, la lecture d'une
-- commande et la réactivation). "updated_at" n'est volontairement pas modifié.
--
-- Rejouable : une commande traitée n'est plus active et sort d'elle-même du
-- filtre. Aucun déclencheur sur "Order" (crm_suivre_passage est sur
-- "CrmContact"). Chaque commande traitée laisse une ligne dans le journal
-- d'audit, avec la valeur d'avant de "cancelled_by".

WITH paniers AS (
  -- "avant" : la même ligne, lue avant l'écriture, pour garder l'ancienne
  -- valeur de "cancelled_by" au journal. Les conditions portent sur "o" :
  -- PostgreSQL les revérifie sur la ligne verrouillée si elle a changé entre
  -- la lecture et l'écriture.
  UPDATE "Order" o
     SET "entity_status" = 'DELETED',
         "deleted_at" = o."cancelled_at",
         "cancelled_by" = 'client'
    FROM "Order" avant
   WHERE avant."id" = o."id"
     AND o."auto" = true
     AND o."payment_method" = 'ONLINE'
     AND o."paied" = false
     AND o."paied_at" IS NULL
     AND o."status" = 'CANCELLED'
     AND o."accepted_at" IS NULL
     AND o."entity_status" = 'ACTIVE'
     AND o."cancelled_at" IS NOT NULL
     AND o."cancelled_at" >= TIMESTAMP '2026-09-30 00:00:00'
     AND o."updated_at" >= TIMESTAMP '2026-09-30 00:00:00'
     AND (o."cancelled_by" = o."customer_id"::text OR o."cancelled_by" = 'client')
     AND NOT EXISTS (
       SELECT 1 FROM "Paiement" p
        WHERE p."order_id" = o."id"
          AND p."status" = 'SUCCESS'
     )
  RETURNING o."id", o."reference", o."restaurant_id", o."cancelled_at", avant."cancelled_by" AS "cancelled_by_avant"
)
-- "id" fourni explicitement, comme dans les autres migrations du dépôt : le
-- défaut SQL de la colonne n'est pas déclaré dans le schéma Prisma, et ne
-- doit pas être une condition de réussite.
INSERT INTO "audit_logs" ("id", "action", "module", "entity_id", "method", "path", "summary", "metadata", "restaurant_id")
SELECT gen_random_uuid(),
       'UPDATE',
       'orders',
       p."id"::text,
       'SQL',
       'migration 20261001180000_paniers_annules_par_le_client',
       'Panier annulé par le client : retiré des listes, suivi dans À relancer',
       jsonb_build_object(
         'reference', p."reference",
         'entity_status_avant', 'ACTIVE',
         'entity_status_apres', 'DELETED',
         'cancelled_by_avant', p."cancelled_by_avant",
         'cancelled_by_apres', 'client',
         'annulee_le', p."cancelled_at"
       ),
       p."restaurant_id"
  FROM paniers p;

-- FICHES CRM : compteur « Paiements abandonnés ».
--
-- "CrmContact"."abandoned_orders" recopie le nombre de commandes SUPPRIMÉES
-- du client (CrmSyncService.entretenir, même définition). Le serveur ne le
-- recalcule qu'à un événement de commande de ce client, et la réconciliation
-- périodique ne le revoit pas sur une fiche existante : sans cette
-- instruction, les clients dont un panier vient de passer DELETED restaient
-- sous-comptés (fiche, filtre « paiement abandonné », export, tableau de bord)
-- jusqu'à leur prochaine commande.
--
-- Rejouable : la valeur est recalculée, et seules les fiches dont le compteur
-- diffère sont écrites. Périmètre : les clients ayant au moins un panier
-- annulé par le client et supprimé. Le déclencheur crm_suivre_passage ne
-- surveille que "cycle", "segment" et "segment_since" : il ne se déclenche pas.
UPDATE "CrmContact" x
   SET "abandoned_orders" = n."total"
  FROM (
    SELECT o."customer_id", count(*)::int AS "total"
      FROM "Order" o
     WHERE o."entity_status" = 'DELETED'
       AND o."customer_id" IN (
         SELECT a."customer_id"
           FROM "Order" a
          WHERE a."cancelled_by" = 'client'
            AND a."entity_status" = 'DELETED'
       )
     GROUP BY o."customer_id"
  ) n
 WHERE x."customer_id" = n."customer_id"
   AND x."entity_status" <> 'DELETED'
   AND x."abandoned_orders" IS DISTINCT FROM n."total";
