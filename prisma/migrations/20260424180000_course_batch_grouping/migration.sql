-- Migration ciblée (pattern Neon, pas de drift).
--
-- Phase 3 de la refonte : regroupement intelligent des commandes en batch.
-- Un batch agrège 1..N Orders `READY` du même restaurant pendant une fenêtre
-- configurable (`course.batch_window_seconds`, default 180 s) puis crée une
-- Course unique au flush (cron toutes les 10 s ou saturation du plafond).

-- ── Enum CourseBatchStatus ───────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CourseBatchStatus" AS ENUM ('PENDING', 'FLUSHED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Table CourseBatch ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CourseBatch" (
  "id"            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "restaurant_id" UUID           NOT NULL,
  "status"        "CourseBatchStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at"    TIMESTAMP(6)   NOT NULL,
  "course_id"     UUID           UNIQUE,
  "flushed_at"    TIMESTAMP(6),
  "created_at"    TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(6)   NOT NULL DEFAULT NOW(),

  CONSTRAINT "CourseBatch_restaurant_fkey"
    FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE,
  CONSTRAINT "CourseBatch_course_fkey"
    FOREIGN KEY ("course_id") REFERENCES "Course"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "CourseBatch_restaurant_status_idx"
  ON "CourseBatch" ("restaurant_id", "status");

CREATE INDEX IF NOT EXISTS "CourseBatch_status_expires_idx"
  ON "CourseBatch" ("status", "expires_at"); -- utilisé par le cron de flush

-- ── Colonne Order.batch_id (ajout non-bloquant) ──────────────────────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "batch_id" UUID;

DO $$ BEGIN
  ALTER TABLE "Order"
    ADD CONSTRAINT "Order_batch_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "CourseBatch"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Order_batch_idx" ON "Order" ("batch_id");
