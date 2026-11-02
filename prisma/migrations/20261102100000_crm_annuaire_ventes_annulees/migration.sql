-- CRM : fausses ventes de l'annuaire annulées (reprise du 02/11, problème 1).
--
-- POURQUOI
-- Depuis la mise en production du 24/10, une fiche de l'annuaire (segment
-- CLIENT, statut NON_DEMARCHE) entrait avec comme date d'entrée la DERNIÈRE
-- commande du client. La réconciliation (toutes les 10 minutes) et chaque
-- événement de commande prenaient cette commande pour une conversion : la
-- fiche passait CONVERTI et une vente « CRM » entrait au registre, sans
-- qu'aucun agent n'ait appelé le client. Effets : ventes et chiffre d'affaires
-- du CRM gonflés ; « Prendre en charge » impossible ; clients retombés
-- inactifs en second passage, donc pris pour « déjà reconquis une fois ».
-- Le code est corrigé dans le même lot ; cette migration répare les données.
--
-- PÉRIMÈTRE (critères stricts)
-- Point de départ : chaque vente ACTIVE du registre d'une fiche d'annuaire
-- ("CrmConversion" : segment = 'CLIENT', source = 'CRM', cancelled_at nul).
-- Date de prise = la plus ancienne, ANTÉRIEURE à l'inscription de la vente,
-- du premier événement ASSIGNATION (hors « Retiré de son agent ») et du
-- premier appel du même cycle.
--   cas A  : aucune prise                         -> vente fausse
--   cas C  : commande antérieure à la prise       -> vente fausse
--   gardée : commande postérieure à la prise      -> vente juste, intacte
-- État de la fiche, pour A et C :
--   SANS_RECHUTE : même cycle, segment CLIENT, CONVERTI par la commande de la vente -> réparée
--   RECHUTE      : cycle suivant, INACTIF, passage suivant présent, passage de la
--                  vente absent ou CLIENT                                      -> réparée
--   SUPPRIMEE    : fiche supprimée                                             -> vente annulée seule
--   AUTRE        : tout le reste                                               -> rien (compté par la mesure)
--
-- CE QU'ELLE FAIT, dans l'ordre
--   1. Journal : une ligne RETOUR par vente reprise. Rien n'est effacé.
--   2. Ventes A et C : annulées (cancelled_at, cancel_reason), jamais supprimées.
--   3. Fiches A sans rechute : de nouveau « non démarchées », conversion effacée.
--   4. Fiches C sans rechute : statut d'avant la conversion, date d'entrée = la
--      prise, agent gardé. Une commande postérieure à la prise les convertira
--      au passage suivant de la réconciliation, comme une vraie vente.
--   5. Fiches retombées (A ou C) : le second passage redevient le premier.
--      Statut, agent et campagne ne changent pas. Les appels et coupons du
--      passage « client actif » supprimé passent dans l'historique (passage 0) :
--      sinon ses essais sans réponse compteraient pour l'inactif.
--   6. Fiches de l'annuaire déjà « rétablies » par l'ancien code (commande
--      supprimée ou annulée, vente déjà annulée) : restées « à appeler » sans
--      agent, sans appel ni coupon, jamais prises en charge. Elles redeviennent
--      « non démarchées » (sinon leur prochaine commande ferait une nouvelle
--      fausse vente, et elles ne deviendraient jamais inactives).
--   7. Fiches CLIENT prises en charge, encore ouvertes : date d'entrée = la prise
--      quand elle est plus récente (sinon une commande d'avant la prise les
--      convertirait).
--   8. Problème 22 : fiches non converties encore rattachées à une campagne
--      terminée, détachées (comme le fait la clôture).
--
-- CE QU'ELLE LAISSE
-- Ventes justes (commande passée après la prise), ventes des autres publics,
-- fiches « AUTRE », fiches converties d'une campagne terminée, journal, appels
-- et coupons existants (seul le numéro de passage des fiches retombées change).
--
-- REJOUABLE
-- Tout tient dans UN bloc DO (une instruction : tout ou rien). Une vente reprise
-- est annulée et ne remplit plus le critère ; chaque écriture est gardée par
-- l'état attendu. Un second passage ne touche rien.
-- ⚠️ Le déclencheur crm_suivre_passage recopie la date d'entrée sur le passage
-- (étapes 4 et 7) et ne crée aucun passage à l'étape 5 (la ligne existe déjà).
--
-- ⚠️⚠️ RETOUR À L'ANCIENNE IMAGE (:prod-rollback)
-- La réparation ne tient qu'avec le nouveau code. L'ancien serveur reconvertit
-- toute fiche « non démarchée » par sa dernière commande, avec une NOUVELLE
-- fausse vente, et Prisma ne rejoue jamais une migration déjà inscrite. Après
-- TOUT retour à l'ancienne image, même court, une fois le nouveau code remis :
--   1. relancer à la main le bloc DO ci-dessous, recopié à l'identique dans
--      scripts/sql/2026-11-02_crm_annuaire_reprise.sql (rejouable) :
--        psql "$DATABASE_URL" -f scripts/sql/2026-11-02_crm_annuaire_reprise.sql
--   2. puis lancer le CONTRÔLE APRÈS ci-dessous.
--
-- MESURE AVANT (lecture seule, à lancer avant le déploiement) :
--
-- WITH ventes AS (
--   SELECT cv."id" AS vente_id, cv."contact_id", cv."cycle", cv."order_id", cv."amount", cv."converted_at", cv."created_at" AS inscrite_le
--   FROM "CrmConversion" cv
--   WHERE cv."segment" = 'CLIENT' AND cv."source" = 'CRM' AND cv."cancelled_at" IS NULL
-- ),
-- prises AS (
--   SELECT ve.vente_id, least(
--     (SELECT min(e."created_at") FROM "CrmEvent" e
--       WHERE e."contact_id" = ve."contact_id" AND e."type" = 'ASSIGNATION'
--         AND e."label" <> 'Retiré de son agent' AND e."created_at" <= ve.inscrite_le),
--     (SELECT min(k."created_at") FROM "CrmCall" k
--       WHERE k."contact_id" = ve."contact_id" AND k."cycle" = ve."cycle" AND k."created_at" <= ve.inscrite_le)
--   ) AS prise_le
--   FROM ventes ve
-- ),
-- f AS (
--   SELECT ve.*, pr.prise_le,
--     CASE WHEN pr.prise_le IS NULL THEN 'A' WHEN ve."converted_at" < pr.prise_le THEN 'C' ELSE 'GARDEE' END AS cas,
--     CASE WHEN x."entity_status" = 'DELETED' THEN 'SUPPRIMEE'
--          WHEN x."cycle" = ve."cycle" AND x."segment" = 'CLIENT' AND x."status" = 'CONVERTI'
--               AND x."conversion_order_id" = ve."order_id" THEN 'SANS_RECHUTE'
--          WHEN x."cycle" = ve."cycle" + 1 AND x."segment" = 'INACTIF'
--               AND EXISTS (SELECT 1 FROM "CrmCycle" y WHERE y."contact_id" = x."id" AND y."cycle" = ve."cycle" + 1)
--               AND NOT EXISTS (SELECT 1 FROM "CrmCycle" y WHERE y."contact_id" = x."id" AND y."cycle" = ve."cycle" AND y."segment" <> 'CLIENT')
--               THEN 'RECHUTE'
--          ELSE 'AUTRE' END AS etat
--   FROM ventes ve JOIN prises pr ON pr.vente_id = ve.vente_id JOIN "CrmContact" x ON x."id" = ve."contact_id"
-- )
-- SELECT cas, etat, count(*) AS fiches, round(sum("amount")) AS montant_f,
--        min("converted_at")::date AS du, max("converted_at")::date AS au
-- FROM f GROUP BY cas, etat ORDER BY cas, etat;
--
-- -- Fiches CLIENT prises en charge, ouvertes, dont la date d'entrée précède la prise
-- SELECT count(*) FROM "CrmContact" x
-- WHERE x."segment" = 'CLIENT' AND x."status" IN ('A_APPELER','A_RAPPELER','INTERESSE','COUPON_ENVOYE')
--   AND x."entity_status" <> 'DELETED'
--   AND x."segment_since" < least(
--        (SELECT min(e."created_at") FROM "CrmEvent" e
--          WHERE e."contact_id" = x."id" AND e."type" = 'ASSIGNATION' AND e."label" <> 'Retiré de son agent'),
--        (SELECT min(k."created_at") FROM "CrmCall" k WHERE k."contact_id" = x."id" AND k."cycle" = x."cycle"));
--
-- -- Fiches non converties rattachées à une campagne terminée (22)
-- SELECT count(*) FROM "CrmContact" x JOIN "ConversionCampaign" c ON c."id" = x."campaign_id"
-- WHERE c."status" = 'COMPLETED' AND x."status" <> 'CONVERTI';
--
-- -- Fiches de l'annuaire déjà « rétablies » par l'ancien code, jamais prises en charge (étape 6)
-- SELECT count(*) FROM "CrmContact" x
-- WHERE x."segment" = 'CLIENT' AND x."status" IN ('A_APPELER','A_RAPPELER','INTERESSE','COUPON_ENVOYE')
--   AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL AND x."call_count" = 0 AND x."entity_status" <> 'DELETED'
--   AND NOT EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id")
--   AND NOT EXISTS (SELECT 1 FROM "CrmCall" k WHERE k."contact_id" = x."id" AND k."cycle" = x."cycle")
--   AND NOT EXISTS (SELECT 1 FROM "CrmEvent" e WHERE e."contact_id" = x."id" AND e."type" = 'ASSIGNATION'
--                     AND e."label" <> 'Retiré de son agent');
--
-- CONTRÔLE APRÈS (la requête de l'étape 6 ci-dessus doit alors répondre 0) :
--
-- SELECT "cancel_reason", count(*), round(sum("amount")) FROM "CrmConversion" WHERE "cancel_reason" IS NOT NULL GROUP BY 1;
-- SELECT "segment", "status", "cycle" >= 2 AS passage2, count(*) FROM "CrmContact" WHERE "segment" IN ('CLIENT','INACTIF') GROUP BY 1,2,3;
-- SELECT "data"->>'cas' AS cas, count(*) FROM "CrmEvent" WHERE "data"->>'reprise' = 'annuaire_0211' GROUP BY 1;

ALTER TABLE "CrmConversion" ADD COLUMN IF NOT EXISTS "cancel_reason" VARCHAR(40);

DO $$
BEGIN
  -- Ventes reprises : cas A et C, fiches réparables ou supprimées. Calculées une
  -- fois, avant toute écriture.
  DROP TABLE IF EXISTS pg_temp.crm_reprise_annuaire;
  CREATE TEMP TABLE crm_reprise_annuaire ON COMMIT DROP AS
  WITH ventes AS (
    SELECT cv."id" AS vente_id, cv."contact_id", cv."cycle", cv."order_id", cv."amount", cv."converted_at", cv."created_at" AS inscrite_le
    FROM "CrmConversion" cv
    WHERE cv."segment" = 'CLIENT' AND cv."source" = 'CRM' AND cv."cancelled_at" IS NULL
  ),
  prises AS (
    SELECT ve.vente_id, least(
      (SELECT min(e."created_at") FROM "CrmEvent" e
        WHERE e."contact_id" = ve."contact_id" AND e."type" = 'ASSIGNATION'
          AND e."label" <> 'Retiré de son agent' AND e."created_at" <= ve.inscrite_le),
      (SELECT min(k."created_at") FROM "CrmCall" k
        WHERE k."contact_id" = ve."contact_id" AND k."cycle" = ve."cycle" AND k."created_at" <= ve.inscrite_le)
    ) AS prise_le
    FROM ventes ve
  ),
  f AS (
    SELECT ve.*, pr.prise_le,
      CASE WHEN pr.prise_le IS NULL THEN 'A' WHEN ve."converted_at" < pr.prise_le THEN 'C' ELSE 'GARDEE' END AS cas,
      CASE WHEN x."entity_status" = 'DELETED' THEN 'SUPPRIMEE'
           WHEN x."cycle" = ve."cycle" AND x."segment" = 'CLIENT' AND x."status" = 'CONVERTI'
                AND x."conversion_order_id" = ve."order_id" THEN 'SANS_RECHUTE'
           WHEN x."cycle" = ve."cycle" + 1 AND x."segment" = 'INACTIF'
                AND EXISTS (SELECT 1 FROM "CrmCycle" y WHERE y."contact_id" = x."id" AND y."cycle" = ve."cycle" + 1)
                AND NOT EXISTS (SELECT 1 FROM "CrmCycle" y WHERE y."contact_id" = x."id" AND y."cycle" = ve."cycle" AND y."segment" <> 'CLIENT')
                THEN 'RECHUTE'
           ELSE 'AUTRE' END AS etat
    FROM ventes ve JOIN prises pr ON pr.vente_id = ve.vente_id JOIN "CrmContact" x ON x."id" = ve."contact_id"
  )
  SELECT * FROM f WHERE cas IN ('A', 'C') AND etat IN ('SANS_RECHUTE', 'RECHUTE', 'SUPPRIMEE');

  -- 1. Journal : une ligne par vente reprise, une seule fois.
  INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label", "data")
  SELECT gen_random_uuid(), r."contact_id", 'RETOUR'::"CrmEventType",
         CASE WHEN r.etat = 'RECHUTE' THEN 'Passage corrigé : sa commande n''était pas une vente du centre d''appels'
              WHEN r.cas = 'A' AND r.etat = 'SANS_RECHUTE' THEN 'Remis dans l''annuaire : sa commande n''était pas une vente du centre d''appels'
              WHEN r.cas = 'A' THEN 'Vente annulée : commande passée sans appel du centre d''appels'
              ELSE 'Vente annulée : la commande précédait la prise en charge' END,
         jsonb_build_object('reprise', 'annuaire_0211', 'vente', r.vente_id, 'commande', r."order_id", 'cas', r.cas)
  FROM crm_reprise_annuaire r
  WHERE NOT EXISTS (
    SELECT 1 FROM "CrmEvent" e
    WHERE e."contact_id" = r."contact_id" AND e."data"->>'reprise' = 'annuaire_0211' AND e."data"->>'vente' = r.vente_id::text);

  -- 2. Ventes annulées, jamais supprimées.
  UPDATE "CrmConversion" v
  SET "cancelled_at" = now(),
      "cancel_reason" = CASE r.cas WHEN 'A' THEN 'ANNUAIRE_SANS_APPEL' ELSE 'COMMANDE_AVANT_PRISE' END
  FROM crm_reprise_annuaire r
  WHERE v."id" = r.vente_id AND v."cancelled_at" IS NULL;

  -- 3. Fiches A sans rechute : de nouveau « non démarchées ». Public, passage
  --    et agent (nul) inchangés ; la bascule horaire les passera inactives si
  --    leur dernière commande dépasse le délai.
  UPDATE "CrmContact" x
  SET "status" = 'NON_DEMARCHE', "converted_at" = NULL, "conversion_order_id" = NULL, "conversion_amount" = NULL,
      "updated_at" = now()
  FROM crm_reprise_annuaire r
  WHERE r.cas = 'A' AND r.etat = 'SANS_RECHUTE' AND x."id" = r."contact_id"
    AND x."status" = 'CONVERTI' AND x."segment" = 'CLIENT' AND x."conversion_order_id" = r."order_id" AND x."cycle" = r."cycle";

  -- 4. Fiches C sans rechute : statut reconstitué comme statutSansConversion
  --    (coupon valable, sinon issue du dernier appel, sinon « à appeler »),
  --    date d'entrée = la prise, agent gardé.
  UPDATE "CrmContact" x
  SET "status" = (CASE
        WHEN EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id" AND k."used_at" IS NULL AND k."expires_at" > now())
          THEN 'COUPON_ENVOYE'
        WHEN x."last_call_outcome" = 'A_RAPPELER' THEN 'A_RAPPELER'
        WHEN x."last_call_outcome" = 'INTERESSE' THEN 'INTERESSE'
        WHEN x."last_call_outcome" = 'NON_INTERESSE' THEN 'NON_INTERESSE'
        WHEN x."last_call_outcome" = 'NUMERO_INVALIDE' THEN 'INJOIGNABLE'
        ELSE 'A_APPELER' END)::"CrmStatus",
      "segment_since" = r.prise_le,
      "converted_at" = NULL, "conversion_order_id" = NULL, "conversion_amount" = NULL,
      "updated_at" = now()
  FROM crm_reprise_annuaire r
  WHERE r.cas = 'C' AND r.etat = 'SANS_RECHUTE' AND x."id" = r."contact_id"
    AND x."status" = 'CONVERTI' AND x."segment" = 'CLIENT' AND x."conversion_order_id" = r."order_id" AND x."cycle" = r."cycle";

  -- 5. Fiches retombées : le second passage redevient le premier. Chaque
  --    instruction est gardée par l'état d'avant (fiche au cycle suivant,
  --    inactive), que seule la dernière change.
  --    5.1 Le passage CLIENT de la vente disparaît, seulement si le suivant existe.
  DELETE FROM "CrmCycle" y
  USING crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND y."contact_id" = r."contact_id" AND y."cycle" = r."cycle" AND y."segment" = 'CLIENT'
    AND EXISTS (SELECT 1 FROM "CrmCycle" z WHERE z."contact_id" = r."contact_id" AND z."cycle" = r."cycle" + 1);

  --    5.2 Appels et coupons du passage CLIENT supprimé : rangés dans
  --        l'historique (passage 0, comme ce qui précède le premier passage).
  --        Restés à leur numéro, ils tomberaient dans le passage inactif
  --        renuméroté : les « pas de réponse » faits comme client actif
  --        compteraient pour l'inactif (sortie « injoignable » dès le premier
  --        essai), et les chiffres par passage aussi. Avant 5.4, qui donne ce
  --        numéro aux appels du passage suivant.
  UPDATE "CrmCall" k SET "cycle" = 0
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND k."contact_id" = r."contact_id" AND k."cycle" = r."cycle";
  UPDATE "CrmCoupon" k SET "cycle" = 0
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND k."contact_id" = r."contact_id" AND k."cycle" = r."cycle";

  --    5.3 Le passage suivant prend son numéro, si aucun ne le porte plus.
  UPDATE "CrmCycle" y SET "cycle" = r."cycle"
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND y."contact_id" = r."contact_id" AND y."cycle" = r."cycle" + 1
    AND NOT EXISTS (SELECT 1 FROM "CrmCycle" z WHERE z."contact_id" = r."contact_id" AND z."cycle" = r."cycle");

  --    5.4 Appels, coupons, membres de campagne et ventes du passage suivant.
  --        La vente fausse est déjà annulée : l'index unique partiel
  --        (fiche, cycle, ventes actives) ne bloque pas.
  UPDATE "CrmCall" k SET "cycle" = r."cycle"
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND k."contact_id" = r."contact_id" AND k."cycle" = r."cycle" + 1;
  UPDATE "CrmCoupon" k SET "cycle" = r."cycle"
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND k."contact_id" = r."contact_id" AND k."cycle" = r."cycle" + 1;
  UPDATE "CrmCampaignMember" m SET "cycle" = r."cycle"
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND m."contact_id" = r."contact_id" AND m."cycle" = r."cycle" + 1;
  UPDATE "CrmConversion" v SET "cycle" = r."cycle"
  FROM crm_reprise_annuaire r, "CrmContact" x
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND v."contact_id" = r."contact_id" AND v."cycle" = r."cycle" + 1;

  --    5.5 La fiche en dernier, seulement si son passage renuméroté est là :
  --        le déclencheur ne crée alors rien.
  UPDATE "CrmContact" x SET "cycle" = r."cycle", "updated_at" = now()
  FROM crm_reprise_annuaire r
  WHERE r.etat = 'RECHUTE' AND x."id" = r."contact_id" AND x."cycle" = r."cycle" + 1 AND x."segment" = 'INACTIF'
    AND EXISTS (SELECT 1 FROM "CrmCycle" z WHERE z."contact_id" = x."id" AND z."cycle" = r."cycle" AND z."segment" = 'INACTIF');

  -- 6. Fiches de l'annuaire déjà « rétablies » par l'ancien code : leur
  --    commande « convertissante » a été supprimée ou annulée, leur vente est
  --    déjà annulée, mais elles sont restées « à appeler » sans agent, sans
  --    appel, sans coupon, jamais prises en charge. Elles n'étaient dans
  --    aucune file, ne pouvaient plus être prises en charge ni devenir
  --    inactives, et leur prochaine commande faisait une nouvelle fausse vente
  --    (seul « non démarché » en est protégé). Elles redeviennent « non
  --    démarchées », comme le fait désormais le rétablissement (problème 16).
  --    Gardé par l'état : une fois « non démarchées », elles ne sont plus visées.
  DROP TABLE IF EXISTS pg_temp.crm_reprise_annuaire_retablies;
  CREATE TEMP TABLE crm_reprise_annuaire_retablies ON COMMIT DROP AS
  SELECT x."id" FROM "CrmContact" x
  WHERE x."segment" = 'CLIENT' AND x."status" IN ('A_APPELER', 'A_RAPPELER', 'INTERESSE', 'COUPON_ENVOYE')
    AND x."assigned_to_id" IS NULL AND x."campaign_id" IS NULL AND x."call_count" = 0 AND x."entity_status" <> 'DELETED'
    AND NOT EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id")
    AND NOT EXISTS (SELECT 1 FROM "CrmCall" k WHERE k."contact_id" = x."id" AND k."cycle" = x."cycle")
    AND NOT EXISTS (SELECT 1 FROM "CrmEvent" e WHERE e."contact_id" = x."id" AND e."type" = 'ASSIGNATION'
                      AND e."label" <> 'Retiré de son agent');

  INSERT INTO "CrmEvent" ("id", "contact_id", "type", "label", "data")
  SELECT gen_random_uuid(), t."id", 'RETOUR'::"CrmEventType",
         'Remis dans l''annuaire : aucun agent ne l''avait pris en charge',
         jsonb_build_object('reprise', 'annuaire_0211', 'cas', 'RETABLIE')
  FROM crm_reprise_annuaire_retablies t;

  UPDATE "CrmContact" x SET "status" = 'NON_DEMARCHE', "updated_at" = now()
  FROM crm_reprise_annuaire_retablies t
  WHERE x."id" = t."id" AND x."segment" = 'CLIENT' AND x."assigned_to_id" IS NULL
    AND x."status" IN ('A_APPELER', 'A_RAPPELER', 'INTERESSE', 'COUPON_ENVOYE');

  -- 7. Fiches CLIENT prises en charge, encore ouvertes : date d'entrée = la
  --    prise (premier ASSIGNATION hors « Retiré de son agent », ou premier
  --    appel du passage en cours) quand elle est plus récente.
  UPDATE "CrmContact" x SET "segment_since" = p.prise_le, "updated_at" = now()
  FROM (
    SELECT x2."id", least(
      (SELECT min(e."created_at") FROM "CrmEvent" e
        WHERE e."contact_id" = x2."id" AND e."type" = 'ASSIGNATION' AND e."label" <> 'Retiré de son agent'),
      (SELECT min(k."created_at") FROM "CrmCall" k WHERE k."contact_id" = x2."id" AND k."cycle" = x2."cycle")
    ) AS prise_le
    FROM "CrmContact" x2
    WHERE x2."segment" = 'CLIENT' AND x2."status" IN ('A_APPELER', 'A_RAPPELER', 'INTERESSE', 'COUPON_ENVOYE')
      AND x2."entity_status" <> 'DELETED'
  ) p
  WHERE x."id" = p."id" AND p.prise_le IS NOT NULL AND x."segment_since" < p.prise_le;

  -- 8. Problème 22 : une fiche non convertie rattachée à une campagne terminée
  --    n'est dans aucune file. Elle la quitte, comme à la clôture.
  UPDATE "CrmContact" x SET "campaign_id" = NULL, "updated_at" = now()
  FROM "ConversionCampaign" c
  WHERE c."id" = x."campaign_id" AND c."status" = 'COMPLETED' AND x."status" <> 'CONVERTI';
END $$;
