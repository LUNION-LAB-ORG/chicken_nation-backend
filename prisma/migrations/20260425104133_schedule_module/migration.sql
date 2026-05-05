-- Migration ciblée (pattern Neon, pas de drift).
--
-- P7 — Module Schedule : créneaux & disponibilité livreurs.
--
-- 5 entités + 5 enums :
--   * SchedulePlan          → plan de planning période × restaurant
--   * Shift                 → créneau journalier (matin/soir)
--   * ShiftAssignment       → affectation livreur ↔ shift
--   * RestDay               → jour de repos (auto / manuel)
--   * DailyPresenceCheck    → réponse au check-in matinal 8h
--
-- Workflow général :
--   1. ADMIN génère un plan (auto via algo de rotation FIFO)
--   2. ADMIN review puis SEND → push aux livreurs
--   3. Chaque livreur ACCEPT/REFUSE chaque shift assigné
--   4. À 8h chaque matin : check-in présence → auto-CONFIRMED si pas de réponse
--   5. Le livreur peut ajouter/retirer un repos pour LUI-MÊME (cliquable mobile)
--
-- Tous les paramètres sont dans `schedule.*` settings (helper backend).

-- ── Extensions Postgres ──────────────────────────────────────────────────
-- pgcrypto fournit `gen_random_uuid()` utilisé par tous les `DEFAULT` UUID.
-- Idempotent : ne fait rien si déjà installée.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SchedulePlanStatus" AS ENUM ('DRAFT', 'SENT', 'CONFIRMED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ShiftType" AS ENUM ('MORNING', 'EVENING');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ShiftAssignmentStatus" AS ENUM ('ASSIGNED', 'CONFIRMED', 'REFUSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RestDaySource" AS ENUM ('AUTO', 'MANUAL_DELIVERER', 'MANUAL_ADMIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PresenceCheckResponse" AS ENUM ('PRESENT', 'ABSENT', 'NO_RESPONSE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Table SchedulePlan ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SchedulePlan" (
  "id"              UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  "restaurant_id"   UUID                  NOT NULL,
  "period_start"    DATE                  NOT NULL,
  "period_end"      DATE                  NOT NULL,
  "status"          "SchedulePlanStatus"  NOT NULL DEFAULT 'DRAFT',
  "confirmed_count" INTEGER               NOT NULL DEFAULT 0,
  "sent_at"         TIMESTAMP(6),
  "confirmed_at"    TIMESTAMP(6),
  "archived_at"     TIMESTAMP(6),
  "entity_status"   "EntityStatus"        NOT NULL DEFAULT 'ACTIVE',
  "created_at"      TIMESTAMP(6)          NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMP(6)          NOT NULL DEFAULT NOW(),

  CONSTRAINT "SchedulePlan_restaurant_fkey"
    FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "SchedulePlan_restaurant_status_idx"
  ON "SchedulePlan" ("restaurant_id", "status");

CREATE INDEX IF NOT EXISTS "SchedulePlan_period_idx"
  ON "SchedulePlan" ("period_start", "period_end");

-- ── Table Shift ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Shift" (
  "id"            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id"       UUID            NOT NULL,
  "date"          DATE            NOT NULL,
  "type"          "ShiftType"     NOT NULL,
  "start_time"    VARCHAR(5)      NOT NULL,
  "end_time"      VARCHAR(5)      NOT NULL,
  "max_slots"     INTEGER         NOT NULL,
  "entity_status" "EntityStatus"  NOT NULL DEFAULT 'ACTIVE',
  "created_at"    TIMESTAMP(6)    NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(6)    NOT NULL DEFAULT NOW(),

  CONSTRAINT "Shift_plan_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "SchedulePlan"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Shift_plan_date_type_unique"
  ON "Shift" ("plan_id", "date", "type");

CREATE INDEX IF NOT EXISTS "Shift_plan_idx" ON "Shift" ("plan_id");
CREATE INDEX IF NOT EXISTS "Shift_date_idx" ON "Shift" ("date");

-- ── Table ShiftAssignment ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ShiftAssignment" (
  "id"             UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  "shift_id"       UUID                    NOT NULL,
  "deliverer_id"   UUID                    NOT NULL,
  "status"         "ShiftAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
  "confirmed_at"   TIMESTAMP(6),
  "refused_at"     TIMESTAMP(6),
  "refusal_reason" VARCHAR(500),
  "entity_status"  "EntityStatus"          NOT NULL DEFAULT 'ACTIVE',
  "created_at"     TIMESTAMP(6)            NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMP(6)            NOT NULL DEFAULT NOW(),

  CONSTRAINT "ShiftAssignment_shift_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "Shift"("id") ON DELETE CASCADE,
  CONSTRAINT "ShiftAssignment_deliverer_fkey"
    FOREIGN KEY ("deliverer_id") REFERENCES "Deliverer"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShiftAssignment_shift_deliverer_unique"
  ON "ShiftAssignment" ("shift_id", "deliverer_id");

CREATE INDEX IF NOT EXISTS "ShiftAssignment_deliverer_status_idx"
  ON "ShiftAssignment" ("deliverer_id", "status");

CREATE INDEX IF NOT EXISTS "ShiftAssignment_shift_idx"
  ON "ShiftAssignment" ("shift_id");

-- ── Table RestDay ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RestDay" (
  "id"            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  "deliverer_id"  UUID             NOT NULL,
  "date"          DATE             NOT NULL,
  "source"        "RestDaySource"  NOT NULL DEFAULT 'AUTO',
  "reason"        VARCHAR(500),
  "entity_status" "EntityStatus"   NOT NULL DEFAULT 'ACTIVE',
  "created_at"    TIMESTAMP(6)     NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(6)     NOT NULL DEFAULT NOW(),

  CONSTRAINT "RestDay_deliverer_fkey"
    FOREIGN KEY ("deliverer_id") REFERENCES "Deliverer"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestDay_deliverer_date_unique"
  ON "RestDay" ("deliverer_id", "date");

CREATE INDEX IF NOT EXISTS "RestDay_date_idx" ON "RestDay" ("date");

-- ── Table DailyPresenceCheck ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DailyPresenceCheck" (
  "id"            UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  "deliverer_id"  UUID                    NOT NULL,
  "date"          DATE                    NOT NULL,
  "response"      "PresenceCheckResponse" NOT NULL DEFAULT 'NO_RESPONSE',
  "responded_at"  TIMESTAMP(6),
  "shift_type"    "ShiftType",
  "entity_status" "EntityStatus"          NOT NULL DEFAULT 'ACTIVE',
  "created_at"    TIMESTAMP(6)            NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(6)            NOT NULL DEFAULT NOW(),

  CONSTRAINT "DailyPresenceCheck_deliverer_fkey"
    FOREIGN KEY ("deliverer_id") REFERENCES "Deliverer"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyPresenceCheck_deliverer_date_unique"
  ON "DailyPresenceCheck" ("deliverer_id", "date");

CREATE INDEX IF NOT EXISTS "DailyPresenceCheck_date_response_idx"
  ON "DailyPresenceCheck" ("date", "response");
