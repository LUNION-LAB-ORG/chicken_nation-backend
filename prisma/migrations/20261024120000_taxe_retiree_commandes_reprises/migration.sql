-- TAXE RETIRÉE des commandes déjà reprises par le personnel (la taxe, pas
-- les frais de livraison, qui ne changent pas).
--
-- Demande du 24/10 : une commande du site ou de l'application passée en
-- « Manuel » perd sa taxe (colonne "tax"). Le serveur le fait désormais à
-- la reprise ; jusqu'ici il la gardait pour une commande du site à payer à la
-- livraison (règle du 19/10, annulée) et pour une livraison déjà prête. Cette
-- migration répare les commandes reprises avant le correctif.
--
-- Périmètre volontairement étroit :
--  - commande reprise : manuelle (auto faux) mais née chez le client (canal
--    application ou site, ou canal vide des anciennes commandes de
--    l'application), avec une taxe ; une commande saisie par le personnel
--    n'en a jamais ;
--  - hors HubRise ;
--  - active, encore en cours : ni en attente, ni terminée (l'argent est déjà
--    encaissé), ni annulée ;
--  - modifiée depuis le 30/09 (date des premières reprises) ;
--  - RIEN encaissé : aucun paiement réussi (sinon le client a réglé la taxe
--    et la retirer laisserait un trop-perçu) et aucun encaissement de livreur
--    en attente ;
--  - livraison PAS confiée à Turbo : Turbo ne relit jamais le montant à
--    encaisser qui lui a été envoyé.
--
-- Même règle que le serveur (`OrderService.update`).
-- Rejouable : une commande réparée n'a plus de taxe et sort du filtre.
-- Aucun déclencheur sur "Order". "updated_at" n'est volontairement pas
-- modifié. Chaque commande réparée laisse une ligne dans le journal d'audit.
--
-- Contrôle AVANT (lecture seule, mêmes conditions) :
--   SELECT o."reference", o."tax", o."amount" FROM "Order" o WHERE <conditions ci-dessous>;
-- Contrôle APRÈS :
--   SELECT "entity_id", "metadata" FROM "audit_logs"
--    WHERE "path" = 'migration 20261024120000_taxe_retiree_commandes_reprises';

WITH reprises AS (
  UPDATE "Order" o
     SET "amount" = o."amount" - o."tax",
         "tax" = 0
    FROM (
      SELECT o2."id", o2."tax" AS "tax_avant", o2."amount" AS "amount_avant"
        FROM "Order" o2
       WHERE o2."auto" = false
         AND o2."tax" > 0
         AND (o2."channel" IN ('APP', 'WEB') OR o2."channel" IS NULL)
         AND o2."paied" = false
         AND o2."hubrise_order_id" IS NULL
         AND o2."entity_status" = 'ACTIVE'
         AND o2."status" IN ('ACCEPTED', 'IN_PROGRESS', 'READY', 'PICKED_UP', 'COLLECTED')
         AND o2."updated_at" >= TIMESTAMP '2026-09-30 00:00:00'
         AND NOT EXISTS (
           SELECT 1 FROM "Paiement" p
            WHERE p."order_id" = o2."id"
              AND p."status" IN ('SUCCESS', 'PENDING')
         )
         AND NOT EXISTS (
           SELECT 1 FROM "Delivery" d
             JOIN "Course" c ON c."id" = d."course_id"
            WHERE d."order_id" = o2."id"
              AND c."turbo_escalated_at" IS NOT NULL
         )
       FOR UPDATE
    ) avant
   WHERE o."id" = avant."id"
  RETURNING o."id", o."reference", o."restaurant_id", avant."tax_avant", avant."amount_avant", o."amount" AS "amount_apres"
)
INSERT INTO "audit_logs" ("id", "action", "module", "entity_id", "method", "path", "summary", "metadata", "restaurant_id")
SELECT gen_random_uuid(),
       'UPDATE',
       'orders',
       r."id"::text,
       'SQL',
       'migration 20261024120000_taxe_retiree_commandes_reprises',
       'Taxe retirée : commande reprise par le personnel',
       jsonb_build_object(
         'reference', r."reference",
         'tax_avant', r."tax_avant",
         'amount_avant', r."amount_avant",
         'amount_apres', r."amount_apres"
       ),
       r."restaurant_id"
  FROM reprises r;
