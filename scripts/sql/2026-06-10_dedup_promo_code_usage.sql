-- =============================================================================
-- DEDUP PromoCodeUsage + recalcul usage_count
-- Cause : double enregistrement de l'usage promo →
--   (1) l'app mobile appelle POST /promo-code/:id/record-usage (avec order_id)
--   (2) createv2 ré-enregistre automatiquement le même usage
-- Résultat : 2 lignes PromoCodeUsage par commande (montants parfois différents),
--            et PromoCode.usage_count gonflé.
--
-- Le fix CODE (recordUsage idempotent par promo_code_id+order_id) empêche les
-- NOUVEAUX doublons. Ce script nettoie les doublons DÉJÀ en base.
--
-- ⚠️  ORDRE : lancer les PREVIEW d'abord, vérifier, puis le bloc transactionnel.
-- ⚠️  On ne déduplique QUE les usages rattachés à une commande (order_id non nul).
--     Les usages order_id IS NULL (manuels) sont laissés intacts.
-- =============================================================================


-- =============================================================================
-- PREVIEW 1 — Groupes en doublon (même promo_code + même commande, >1 ligne)
-- =============================================================================
SELECT promo_code_id,
       order_id,
       COUNT(*)                       AS nb_lignes,
       array_agg(discount_amount)     AS montants,
       array_agg(id ORDER BY created_at) AS usage_ids
FROM "PromoCodeUsage"
WHERE order_id IS NOT NULL
GROUP BY promo_code_id, order_id
HAVING COUNT(*) > 1
ORDER BY nb_lignes DESC;


-- =============================================================================
-- PREVIEW 2 — Lignes qui seront SUPPRIMÉES (on garde la plus ancienne par groupe)
-- =============================================================================
WITH ranked AS (
  SELECT id, promo_code_id, order_id, discount_amount, created_at,
         ROW_NUMBER() OVER (
           PARTITION BY promo_code_id, order_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM "PromoCodeUsage"
  WHERE order_id IS NOT NULL
)
SELECT id, promo_code_id, order_id, discount_amount, created_at
FROM ranked
WHERE rn > 1
ORDER BY promo_code_id, order_id;


-- =============================================================================
-- PREVIEW 3 — usage_count actuel vs recalculé (après dédup) par code
-- =============================================================================
WITH ranked AS (
  SELECT id, promo_code_id,
         ROW_NUMBER() OVER (
           PARTITION BY promo_code_id, order_id
           ORDER BY created_at ASC, id ASC
         ) AS rn,
         order_id
  FROM "PromoCodeUsage"
),
kept AS (
  -- lignes conservées : tout ce qui a order_id NULL + 1 par groupe (rn=1)
  SELECT promo_code_id FROM ranked WHERE order_id IS NULL
  UNION ALL
  SELECT promo_code_id FROM ranked WHERE order_id IS NOT NULL AND rn = 1
)
SELECT pc.code,
       pc.usage_count                          AS usage_count_actuel,
       (SELECT COUNT(*) FROM kept k WHERE k.promo_code_id = pc.id) AS usage_count_recalcule
FROM "PromoCode" pc
WHERE pc.usage_count <> (SELECT COUNT(*) FROM kept k WHERE k.promo_code_id = pc.id)
ORDER BY pc.code;


-- =============================================================================
-- APPLY — Supprime les doublons + recale usage_count (transaction)
-- Décommenter après validation des PREVIEW.
-- =============================================================================
-- BEGIN;
--
-- -- 1. Supprimer les doublons (garder la ligne la plus ancienne par commande)
-- DELETE FROM "PromoCodeUsage"
-- WHERE id IN (
--   SELECT id FROM (
--     SELECT id,
--            ROW_NUMBER() OVER (
--              PARTITION BY promo_code_id, order_id
--              ORDER BY created_at ASC, id ASC
--            ) AS rn
--     FROM "PromoCodeUsage"
--     WHERE order_id IS NOT NULL
--   ) t
--   WHERE t.rn > 1
-- );
--
-- -- 2. Recaler usage_count = nombre réel de lignes PromoCodeUsage par code
-- UPDATE "PromoCode" pc
-- SET usage_count = (
--   SELECT COUNT(*) FROM "PromoCodeUsage" pcu WHERE pcu.promo_code_id = pc.id
-- );
--
-- -- Vérifier les comptes affichés, puis :
-- COMMIT;   -- ou ROLLBACK;


-- =============================================================================
-- VÉRIFICATION POST-DÉDUP — doit renvoyer 0 ligne
-- =============================================================================
-- SELECT promo_code_id, order_id, COUNT(*)
-- FROM "PromoCodeUsage"
-- WHERE order_id IS NOT NULL
-- GROUP BY promo_code_id, order_id
-- HAVING COUNT(*) > 1;


-- =============================================================================
-- (OPTIONNEL, RECOMMANDÉ) — Garde-fou base de données : index unique partiel
-- empêchant DÉFINITIVEMENT 2 usages du même code pour la même commande.
-- À créer APRÈS la dédup (sinon l'index échoue sur les doublons existants).
-- ⚠️ À ajouter idéalement via une migration Prisma (pour rester synchro avec
--    le schema). Voir note dans la réponse.
-- =============================================================================
-- CREATE UNIQUE INDEX IF NOT EXISTS "PromoCodeUsage_promo_order_unique"
-- ON "PromoCodeUsage" (promo_code_id, order_id)
-- WHERE order_id IS NOT NULL;
