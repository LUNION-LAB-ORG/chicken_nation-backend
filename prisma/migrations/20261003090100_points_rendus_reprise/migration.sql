-- POINTS RENDUS : reprise des remboursements faits depuis le 02/10.
--
-- Du 02/10 (commit 3c398ef) au déploiement de REFUNDED, une commande annulée
-- dont les points avaient été retirés laissait deux lignes, écrites ensemble
-- par LoyaltyService.rendrePointsUtilises :
--  - la ligne de retrait passée de REDEEMED à EXPIRED, raison
--    « N points utilisés pour la commande #REF, annulée »
--    (libelleRetraitAnnule), "updated_at" = heure du remboursement ;
--  - un crédit BONUS sans commande ("order_id" nul), raison
--    « N points rendus : commande #REF annulée » (libelleRestitution).
--
-- Cette migration leur donne la forme écrite désormais par le serveur :
--  - la ligne EXPIRED redevient REDEEMED, avec sa raison d'origine
--    « 🔥 N points utilisés pour la commande #REF » (libelleRetrait, la raison
--    écrite par le paiement, l'acceptation et la clôture) ;
--  - le crédit BONUS devient REFUNDED et se rattache à la commande.
--
-- Rien d'autre ne bouge : ni les points, ni "points_used", ni "is_used", ni
-- "expires_at" des lignes, ni aucun compteur du client (total_points,
-- lifetime_points, status_points). Le solde des clients ne change pas, et
-- les points rendus restent dépensables comme avant.
--
-- Périmètre volontairement étroit :
--  - raisons comparées À L'IDENTIQUE, reconstruites depuis la référence de la
--    commande et le nombre de points de la ligne de retrait ; aucune autre
--    ligne EXPIRED ou BONUS ne peut correspondre ;
--  - lignes écrites depuis le 02/10 ;
--  - une ligne de retrait n'est reprise qu'avec SON crédit (même client, même
--    nombre de points, même commande). Si une commande avait été remboursée
--    deux fois (reprise puis nouvelle annulation), les lignes sont appariées
--    dans l'ordre chronologique.
--
-- Rejouable : une paire reprise n'est plus EXPIRED / BONUS et sort d'elle-même
-- du filtre. Aucun déclencheur sur "LoyaltyPoint". Chaque paire reprise laisse
-- une ligne dans le journal d'audit.
--
-- Contrôle avant ou après déploiement (lecture seule), nombre de paires
-- restant à reprendre, 0 attendu après :
--
--   SELECT count(*)
--     FROM "LoyaltyPoint" e
--     JOIN "Order" o ON o."id" = e."order_id"
--    WHERE e."type" = 'EXPIRED'
--      AND e."reason" = e."points"::text || ' points utilisés pour la commande #' || o."reference" || ', annulée';

WITH retraits AS (
  SELECT e."id",
         e."customer_id",
         e."order_id",
         e."points",
         o."reference",
         o."restaurant_id",
         ROW_NUMBER() OVER (
           PARTITION BY e."customer_id", e."order_id", e."points"
           ORDER BY e."updated_at", e."id"
         ) AS "rang"
    FROM "LoyaltyPoint" e
    JOIN "Order" o ON o."id" = e."order_id"
   WHERE e."type" = 'EXPIRED'
     AND e."updated_at" >= TIMESTAMP '2026-10-02 00:00:00'
     AND e."reason" = e."points"::text || ' points utilisés pour la commande #' || o."reference" || ', annulée'
),
credits AS (
  SELECT c."id",
         c."customer_id",
         c."points",
         c."reason",
         ROW_NUMBER() OVER (
           PARTITION BY c."customer_id", c."reason"
           ORDER BY c."created_at", c."id"
         ) AS "rang"
    FROM "LoyaltyPoint" c
   WHERE c."type" = 'BONUS'
     AND c."order_id" IS NULL
     AND c."created_at" >= TIMESTAMP '2026-10-02 00:00:00'
     AND c."reason" LIKE '% points rendus : commande #% annulée'
),
paires AS (
  SELECT r."id" AS "retrait_id",
         c."id" AS "credit_id",
         r."customer_id",
         r."order_id",
         r."reference",
         r."restaurant_id",
         r."points"
    FROM retraits r
    JOIN credits c
      ON c."customer_id" = r."customer_id"
     AND c."points" = r."points"
     AND c."reason" = r."points"::text || ' points rendus : commande #' || r."reference" || ' annulée'
     AND c."rang" = r."rang"
),
-- Les deux écritures portent sur des lignes différentes de la même table,
-- dans la même instruction : chacune est exécutée en entier, que la requête
-- finale lise ou non son résultat. Leurs conditions sont revérifiées sur la
-- ligne verrouillée si elle a changé entre la lecture et l'écriture.
retraits_repris AS (
  UPDATE "LoyaltyPoint" l
     SET "type" = 'REDEEMED',
         "reason" = '🔥 ' || p."points"::text || ' points utilisés pour la commande #' || p."reference",
         "updated_at" = (NOW() AT TIME ZONE 'UTC')
    FROM paires p
   WHERE l."id" = p."retrait_id"
     AND l."type" = 'EXPIRED'
  RETURNING l."id"
),
credits_repris AS (
  UPDATE "LoyaltyPoint" l
     SET "type" = 'REFUNDED',
         "order_id" = p."order_id",
         "updated_at" = (NOW() AT TIME ZONE 'UTC')
    FROM paires p
   WHERE l."id" = p."credit_id"
     AND l."type" = 'BONUS'
     AND l."order_id" IS NULL
  RETURNING l."id"
)
-- "id" fourni explicitement, comme dans les autres migrations du dépôt.
INSERT INTO "audit_logs" ("id", "action", "module", "entity_id", "method", "path", "summary", "metadata", "restaurant_id")
SELECT gen_random_uuid(),
       'UPDATE',
       'fidelity',
       p."order_id"::text,
       'SQL',
       'migration 20261003090100_points_rendus_reprise',
       'Points rendus d''une commande annulée : retrait remis en « utilisé », crédit passé en « rendus »',
       jsonb_build_object(
         'reference', p."reference",
         'customer_id', p."customer_id",
         'points', p."points",
         'ligne_retrait', p."retrait_id",
         'ligne_retrait_type_avant', 'EXPIRED',
         'ligne_retrait_type_apres', 'REDEEMED',
         'ligne_credit', p."credit_id",
         'ligne_credit_type_avant', 'BONUS',
         'ligne_credit_type_apres', 'REFUNDED'
       ),
       p."restaurant_id"
  FROM paires p;
