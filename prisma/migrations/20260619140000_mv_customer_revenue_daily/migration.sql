-- ════════════════════════════════════════════════════════════════════════════
-- VUE MATÉRIALISÉE : revenu net par (client, restaurant, jour)
-- ════════════════════════════════════════════════════════════════════════════
-- Pré-calcule la partie COÛTEUSE des stats clients (concentration du CA, top
-- clients, panier…) : la somme du CA par client. Au lieu de re-scanner toute la
-- table "Order" à chaque requête, les endpoints lisent cette table déjà agrégée.
--
-- Grain = (client, restaurant, jour) → on peut TOUJOURS filtrer par plage de
-- dates (colonne `day`) et par restaurant, puis ré-agréger. Les bornes de dates
-- des stats sont alignées au jour (startOfDay/endOfDay) → résultats identiques.
--
-- Filtre = mêmes commandes que getRevenueConcentration : payées + finalisées
-- (COMPLETED/COLLECTED). Rafraîchie par StatisticsMatviewTask (cron 15 min).
--
-- Idempotent (IF NOT EXISTS). Peuplée immédiatement à la création.

CREATE MATERIALIZED VIEW IF NOT EXISTS "mv_customer_revenue_daily" AS
SELECT
  o.customer_id,
  o.restaurant_id,
  (o.created_at)::date           AS day,
  COALESCE(SUM(o.net_amount), 0) AS net_revenue,
  COUNT(*)::int                  AS orders_count
FROM "Order" o
WHERE o.paied = true
  AND o.status IN ('COMPLETED', 'COLLECTED')
GROUP BY o.customer_id, o.restaurant_id, (o.created_at)::date;

-- Index UNIQUE OBLIGATOIRE pour `REFRESH MATERIALIZED VIEW CONCURRENTLY`
-- (rafraîchir sans bloquer les lectures pendant le recalcul).
CREATE UNIQUE INDEX IF NOT EXISTS "mv_customer_revenue_daily_pk"
  ON "mv_customer_revenue_daily" (customer_id, restaurant_id, day);

-- Index de lecture : filtrage par plage de jours, et par restaurant + jour.
CREATE INDEX IF NOT EXISTS "mv_customer_revenue_daily_day_idx"
  ON "mv_customer_revenue_daily" (day);
CREATE INDEX IF NOT EXISTS "mv_customer_revenue_daily_resto_day_idx"
  ON "mv_customer_revenue_daily" (restaurant_id, day);
