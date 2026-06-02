-- Migration ciblée (pattern Neon, idempotente, pas de drift).
--
-- BUG : duplication de SchedulePlan aux MÊMES dates.
-- Cause : la génération ne protège les doublons que par des SELECT non atomiques
-- (cron findFirst + service findFirst d'overlap), AUCUNE contrainte d'unicité DB.
-- Avec 2 backends sur le même Postgres (migration), les 2 instances exécutent le
-- cron horaire en parallèle, les 2 SELECT passent, les 2 CREATE → doublon.
--
-- Le partial unique index ci-dessous garantit AU PLUS 1 plan NON-archivé par
-- (restaurant, date de début). Les plans ARCHIVED restent libres de doublons
-- (historique). Le service est aussi durci (catch P2002) — voir le commit associé.

-- 1) Dédoublonnage : pour chaque (restaurant_id, period_start) ayant plusieurs
--    plans NON archivés, on garde le "meilleur" (CONFIRMED > SENT > DRAFT, puis le
--    plus ancien) et on ARCHIVE les surplus. Réversible (statut, pas de DELETE).
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "restaurant_id", "period_start"
      ORDER BY
        CASE "status"
          WHEN 'CONFIRMED' THEN 0
          WHEN 'SENT' THEN 1
          WHEN 'DRAFT' THEN 2
          ELSE 3
        END,
        "created_at" ASC
    ) AS rn
  FROM "SchedulePlan"
  WHERE "status" <> 'ARCHIVED'
)
UPDATE "SchedulePlan"
SET "status" = 'ARCHIVED', "archived_at" = NOW()
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- 2) Index unique PARTIEL : 1 seul plan actif (non-archivé) par (restaurant, début).
CREATE UNIQUE INDEX IF NOT EXISTS "SchedulePlan_restaurant_period_active_unique"
  ON "SchedulePlan" ("restaurant_id", "period_start")
  WHERE "status" <> 'ARCHIVED';
