-- Migration ciblée (pattern Neon, pas de drift).
--
-- A1 Fix : race condition sur CourseOfferAttempt.
--
-- Sans contrainte d'unicité, deux process parallèles (cron expireOffers
-- toutes les 10 s + rebalance toutes les 30 s + admin retry + cron de batch)
-- peuvent créer 2 `CourseOfferAttempt` PENDING pour le même couple
-- (course, deliverer) — observé en prod avec 7 s d'écart sur la course
-- 35100f93 et 60 s sur 35293309.
--
-- Le partial unique index ci-dessous garantit qu'au plus UNE offer PENDING
-- existe par couple. Les statuts terminaux (ACCEPTED, REFUSED, EXPIRED)
-- restent libres de doublons (chaining = re-offer après expiration normale).
--
-- Le service `CourseOfferService.offerToDeliverer` est aussi durci côté
-- application (transaction + check préalable) — voir le commit associé.

-- Nettoyer d'éventuels doublons PENDING orphelins avant de créer l'index.
-- Stratégie : pour chaque (course_id, deliverer_id) ayant plusieurs PENDING,
-- on garde le plus récent (max offered_at) et on EXPIRE les autres.
WITH duplicates AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "course_id", "deliverer_id"
      ORDER BY "offered_at" DESC
    ) AS rn
  FROM "CourseOfferAttempt"
  WHERE "status" = 'PENDING'
)
UPDATE "CourseOfferAttempt"
SET "status" = 'EXPIRED', "responded_at" = NOW()
WHERE "id" IN (SELECT "id" FROM duplicates WHERE rn > 1);

-- Index partiel : 1 seule offer PENDING par couple (course, deliverer).
CREATE UNIQUE INDEX IF NOT EXISTS "CourseOfferAttempt_pending_unique"
  ON "CourseOfferAttempt" ("course_id", "deliverer_id")
  WHERE "status" = 'PENDING';
