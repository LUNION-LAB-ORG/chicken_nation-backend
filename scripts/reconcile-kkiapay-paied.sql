-- ============================================================================
-- Réconciliation KKiaPay — commandes ONLINE marquées « payées » à tort
-- ============================================================================
-- Contexte : `payWithKkiapay` / `linkPaiementToOrder` passaient `order.paied=true`
-- sans vérifier le statut ni le montant de la transaction (corrigé dans
-- paiements.service.ts — garde-fou statut SUCCESS + cumul ≥ total − tolérance).
-- Ce script NETTOIE l'historique. cf. mémoire project_kkiapay_paied_no_verify.
--
-- ⚠️ À EXÉCUTER MANUELLEMENT, SECTION PAR SECTION, APRÈS REVUE.
-- ⚠️ Chaque UPDATE est enveloppé dans BEGIN … ROLLBACK : vérifie le nombre de
--    lignes touchées, puis remplace `ROLLBACK;` par `COMMIT;` pour valider.
-- ⚠️ Fais un backup / snapshot Neon avant de COMMIT.
-- ============================================================================

-- Tolérance d'arrondi taxe app/back (doit matcher PAYMENT_AMOUNT_TOLERANCE = 50).

-- ----------------------------------------------------------------------------
-- 0) VUE D'ENSEMBLE (lecture seule) — répartition par taux de couverture
-- ----------------------------------------------------------------------------
WITH agg AS (
  SELECT o.id, o.amount,
    COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
              WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) AS paye,
    EXISTS (SELECT 1 FROM "Paiement" p WHERE p.order_id = o.id AND p.status = 'REVERTED') AS reverted,
    EXISTS (SELECT 1 FROM "Paiement" p WHERE p.order_id = o.id) AS has_any
  FROM "Order" o
  WHERE o.paied = true AND o.payment_method = 'ONLINE'
)
SELECT
  CASE
    WHEN paye >= amount - 50   THEN '0 · OK couvert'
    WHEN reverted AND paye = 0 THEN '1 · REMBOURSE -> depayer'
    WHEN NOT has_any           THEN '4 · AUCUN/legacy -> decision'
    WHEN paye < amount * 0.5   THEN '2 · JETON <50% (fraude) -> depayer'
    ELSE                            '3 · SOUS-FACTURE 50-95% (servi) -> garder'
  END AS bucket,
  count(*) AS nb, sum(amount) AS valeur_cmd, sum(amount - paye) AS manque_reel
FROM agg
GROUP BY 1 ORDER BY 1;

-- ============================================================================
-- 1) BUCKET 1 — commandes REMBOURSÉES (REVERTED) restées payées  → dépayer
--    Sûr : l'argent a été rendu, la commande ne doit plus compter comme payée.
-- ============================================================================
-- 1a. Dry-run (liste) :
SELECT o.reference, o.amount, o.created_at::date
FROM "Order" o
WHERE o.paied = true AND o.payment_method = 'ONLINE'
  AND EXISTS (SELECT 1 FROM "Paiement" p WHERE p.order_id = o.id AND p.status = 'REVERTED')
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) < o.amount - 50
ORDER BY o.amount DESC;

-- 1b. Mise à jour (vérifie le count puis COMMIT) :
BEGIN;
UPDATE "Order" o
SET paied = false, paied_at = NULL
WHERE o.paied = true AND o.payment_method = 'ONLINE'
  AND EXISTS (SELECT 1 FROM "Paiement" p WHERE p.order_id = o.id AND p.status = 'REVERTED')
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) < o.amount - 50;
-- attendu ≈ 25 lignes. Si OK :  COMMIT;   sinon :
ROLLBACK;

-- ============================================================================
-- 2) BUCKET 2 — JETONS <50% (fraude / comptes test : TCHEA, GNOBELE…) → dépayer
--    Le client a payé moins de la moitié du total : commande non réellement payée.
-- ============================================================================
-- 2a. Dry-run (liste + qui) :
SELECT o.reference, o.amount,
       COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                 WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) AS paye,
       o.customer_id, o.created_at::date
FROM "Order" o
WHERE o.paied = true AND o.payment_method = 'ONLINE'
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) > 0
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) < o.amount * 0.5
ORDER BY o.amount DESC;

-- 2b. Mise à jour (vérifie le count puis COMMIT) :
BEGIN;
UPDATE "Order" o
SET paied = false, paied_at = NULL
WHERE o.paied = true AND o.payment_method = 'ONLINE'
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) > 0
  AND COALESCE((SELECT SUM(p.amount) FROM "Paiement" p
                WHERE p.order_id = o.id AND p.status = 'SUCCESS'), 0) < o.amount * 0.5;
-- Si OK :  COMMIT;   sinon :
ROLLBACK;

-- ============================================================================
-- 3) BUCKET 3 — SOUS-FACTURÉES 50–95 % (bug app remise/taxe, commande SERVIE)
--    PAR DÉFAUT : AUCUNE ACTION. Le client a payé l'essentiel et a été servi —
--    dé-payer fausserait l'historique. C'est une PERTE RÉALISÉE (manque_reel).
--    Corrigé pour le futur par le fix app (charge order.amount) + garde-fou back.
--    (Décommente seulement si le métier décide d'ajuster amount → montant payé.)
-- ============================================================================
-- (aucune action par défaut — bucket informatif)

-- ============================================================================
-- 4) BUCKET 4 — AUCUN paiement (LEGACY, ancien backend) → DÉCISION MÉTIER
--    50 cmd / ~346 676 F créées par l'ancien code, sans ligne Paiement.
--    PAR DÉFAUT : AUCUNE ACTION (CA historique). Pour les EXCLURE du CA, plutôt
--    qu'un dépaiement, préfère les filtrer dans les rapports (ex. paied=true mais
--    aucune ligne Paiement) — ne pas dépayer pour ne pas casser l'historique.
-- ============================================================================
-- (aucune action par défaut)

-- ============================================================================
-- 5) USAGE DES CODES PROMO — à traiter APRÈS les dépaiements 1 & 2
--    Les commandes dé-payées qui avaient un code_promo ont pu incrémenter
--    PromoCodeUsage à tort. NE PAS faire d'UPDATE brut ici (le modèle d'usage a
--    sa propre logique). Recense d'abord les codes concernés :
SELECT o.code_promo, count(*) AS nb_cmd_depayees
FROM "Order" o
WHERE o.payment_method = 'ONLINE' AND o.paied = false  -- après 1 & 2
  AND o.code_promo IS NOT NULL
GROUP BY o.code_promo;
-- Puis décrémenter via le service métier (PromoCodeService) ou un script dédié
-- idempotent, pas par SQL direct.
