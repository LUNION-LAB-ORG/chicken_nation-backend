-- =============================================================================
-- BACKFILL order.code_promo = 'CN-JPNDA'
-- Contexte : le bug createv2 (app mobile) appliquait la réduction du code promo
--            mais ne persistait PAS Order.code_promo. Résultat : le backoffice
--            affiche « Réduction » sans la raison. Ce script rattrape les
--            commandes du 10 juin 2026 (>= 11h00) concernées.
--
-- ⚠️  TIMEZONE : Côte d'Ivoire = UTC+0. Order.created_at est stocké en UTC
--     (new Date()). Donc '2026-06-10 11:00:00' = 11h00 heure locale CI. OK.
--
-- ⚠️  ORDRE D'EXÉCUTION :
--     1. Lancer les SELECT de PREVIEW (étapes 0, 1, 2) — NE MODIFIENT RIEN.
--     2. Vérifier visuellement les lignes ciblées.
--     3. Lancer l'UPDATE choisi (A puis B si besoin) dans une transaction.
--     4. Re-lancer le PREVIEW pour confirmer (0 ligne restante).
--
-- ⚠️  PromoCodeUsage : pour les commandes créées via createv2, recordUsage()
--     a DÉJÀ créé la ligne PromoCodeUsage + incrémenté PromoCode.usage_count.
--     Ce script NE TOUCHE PAS à ces tables → pas de double comptage.
--     Il ne corrige QUE la colonne Order.code_promo (affichage).
-- =============================================================================


-- =============================================================================
-- ÉTAPE 0 — Le code promo existe-t-il ? (sanity check)
-- =============================================================================
SELECT id, code, discount_type, discount_value, usage_count, is_active,
       start_date, expiration_date
FROM "PromoCode"
WHERE code = 'CN-JPNDA';


-- =============================================================================
-- ÉTAPE 1 — PREVIEW « STRATÉGIE A » (PRÉCISE, recommandée)
-- Commandes qui ont une utilisation CN-JPNDA RÉELLEMENT enregistrée
-- (PromoCodeUsage) mais dont Order.code_promo est NULL → à rattraper.
-- =============================================================================
SELECT o.id,
       o.reference,
       o.created_at,
       o.discount,
       o.amount,
       o.code_promo            AS code_promo_actuel,
       pcu.discount_amount     AS usage_discount,
       pc.code                 AS code_promo_reel
FROM "Order" o
JOIN "PromoCodeUsage" pcu ON pcu.order_id = o.id
JOIN "PromoCode"      pc  ON pc.id = pcu.promo_code_id
WHERE pc.code = 'CN-JPNDA'
  AND o.code_promo IS NULL
ORDER BY o.created_at DESC;


-- =============================================================================
-- ÉTAPE 2 — PREVIEW « STRATÉGIE B » (HEURISTIQUE, le reste)
-- Commandes du 10/06/2026 >= 11h00 AVEC réduction mais SANS code_promo
-- ET sans utilisation promo enregistrée (le cas où même PromoCodeUsage manque).
-- On exclut les réductions de fidélité (points > 0) et de promotion
-- (promotion_id non nul) pour ne cibler QUE des réductions de type code/voucher.
-- ⚠️ Vérifier ces lignes UNE PAR UNE avant l'UPDATE B : l'attribution à
--    CN-JPNDA y est une hypothèse, pas une preuve.
-- =============================================================================
SELECT o.id,
       o.reference,
       o.created_at,
       o.discount,
       o.points,
       o.promotion_id,
       o.amount,
       o.code_promo AS code_promo_actuel
FROM "Order" o
WHERE o.created_at >= '2026-06-10 11:00:00'
  AND o.discount > 0
  AND o.code_promo IS NULL
  AND o.points = 0
  AND o.promotion_id IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM "PromoCodeUsage" pcu WHERE pcu.order_id = o.id
      )
ORDER BY o.created_at DESC;


-- =============================================================================
-- UPDATE A — applique le rattrapage PRÉCIS (via l'usage réellement enregistré).
-- Décommenter et exécuter après validation de l'ÉTAPE 1.
-- =============================================================================
-- BEGIN;
-- UPDATE "Order" o
-- SET code_promo = pc.code,
--     updated_at = now()
-- FROM "PromoCodeUsage" pcu
-- JOIN "PromoCode" pc ON pc.id = pcu.promo_code_id
-- WHERE pcu.order_id = o.id
--   AND pc.code = 'CN-JPNDA'
--   AND o.code_promo IS NULL;
-- -- Vérifier le nombre de lignes affectées, puis :
-- COMMIT;   -- ou ROLLBACK; si le compte est inattendu


-- =============================================================================
-- UPDATE B — applique le rattrapage HEURISTIQUE (commandes du jour sans usage).
-- N'exécuter QUE si l'ÉTAPE 2 a renvoyé des lignes légitimes, après contrôle.
-- =============================================================================
-- BEGIN;
-- UPDATE "Order" o
-- SET code_promo = 'CN-JPNDA',
--     updated_at = now()
-- WHERE o.created_at >= '2026-06-10 11:00:00'
--   AND o.discount > 0
--   AND o.code_promo IS NULL
--   AND o.points = 0
--   AND o.promotion_id IS NULL
--   AND NOT EXISTS (
--         SELECT 1 FROM "PromoCodeUsage" pcu WHERE pcu.order_id = o.id
--       );
-- COMMIT;   -- ou ROLLBACK;


-- =============================================================================
-- ÉTAPE 3 — VÉRIFICATION POST-UPDATE (doit renvoyer 0 ligne si tout est rattrapé)
-- =============================================================================
-- SELECT COUNT(*) AS restantes
-- FROM "Order" o
-- WHERE o.created_at >= '2026-06-10 11:00:00'
--   AND o.discount > 0
--   AND o.code_promo IS NULL;


-- =============================================================================
-- ÉTAPE 4 (DIAGNOSTIC) — Doublons de PromoCodeUsage pour CN-JPNDA
-- L'étape 1 a montré le même order_id répété → plusieurs PromoCodeUsage par
-- commande. Cette requête quantifie le phénomène (usage_count=17 gonflé).
-- =============================================================================
SELECT pcu.order_id,
       o.reference,
       COUNT(*)                       AS nb_usages,
       array_agg(pcu.discount_amount) AS montants,
       array_agg(pcu.id)              AS usage_ids
FROM "PromoCodeUsage" pcu
JOIN "PromoCode" pc ON pc.id = pcu.promo_code_id
LEFT JOIN "Order" o ON o.id = pcu.order_id
WHERE pc.code = 'CN-JPNDA'
GROUP BY pcu.order_id, o.reference
HAVING COUNT(*) > 1
ORDER BY nb_usages DESC;

-- Nombre de commandes DISTINCTES réellement concernées (vs 17 lignes d'usage)
SELECT COUNT(DISTINCT pcu.order_id) AS commandes_distinctes,
       COUNT(*)                      AS lignes_usage_total
FROM "PromoCodeUsage" pcu
JOIN "PromoCode" pc ON pc.id = pcu.promo_code_id
WHERE pc.code = 'CN-JPNDA';
