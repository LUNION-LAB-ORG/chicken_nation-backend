-- COMBO MYSTÈRE — Phase 6 (jeu-concours combinaison secrète + tirage au sort N gagnants).
-- Migration IDEMPOTENTE (IF NOT EXISTS / DO blocks) : safe sur base partagée entre
-- deux backends et re-jouable sans drift (cf. précédents Neon).

-- CreateEnum ComboGameStatus
DO $$ BEGIN
    CREATE TYPE "ComboGameStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'SETTLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable ComboGame
CREATE TABLE IF NOT EXISTS "ComboGame" (
    "id" UUID NOT NULL,
    "title" VARCHAR NOT NULL,
    "description" TEXT,
    "clues" JSONB NOT NULL,
    "solution" JSONB NOT NULL,
    "starts_at" TIMESTAMP(6) NOT NULL,
    "ends_at" TIMESTAMP(6) NOT NULL,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "winners_count" INTEGER NOT NULL DEFAULT 1,
    "prize" JSONB NOT NULL,
    "status" "ComboGameStatus" NOT NULL DEFAULT 'SCHEDULED',
    "settled_at" TIMESTAMP(6),
    "created_by" VARCHAR,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComboGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable ComboAttempt
CREATE TABLE IF NOT EXISTS "ComboAttempt" (
    "id" UUID NOT NULL,
    "combo_game_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "answer" JSONB NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComboAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable ComboWinner
CREATE TABLE IF NOT EXISTS "ComboWinner" (
    "id" UUID NOT NULL,
    "combo_game_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "reward_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComboWinner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComboGame_status_starts_at_idx" ON "ComboGame"("status", "starts_at");
CREATE INDEX IF NOT EXISTS "ComboGame_status_ends_at_idx" ON "ComboGame"("status", "ends_at");
CREATE INDEX IF NOT EXISTS "ComboAttempt_combo_game_id_customer_id_idx" ON "ComboAttempt"("combo_game_id", "customer_id");
CREATE INDEX IF NOT EXISTS "ComboAttempt_combo_game_id_is_correct_idx" ON "ComboAttempt"("combo_game_id", "is_correct");
CREATE INDEX IF NOT EXISTS "ComboWinner_combo_game_id_idx" ON "ComboWinner"("combo_game_id");

-- UNIQUE (idempotence du règlement : 1 gain max / client / partie)
CREATE UNIQUE INDEX IF NOT EXISTS "ComboWinner_combo_game_id_customer_id_key" ON "ComboWinner"("combo_game_id", "customer_id");

-- AddForeignKey (guardées : re-jouables)
DO $$ BEGIN
    ALTER TABLE "ComboAttempt" ADD CONSTRAINT "ComboAttempt_combo_game_id_fkey"
        FOREIGN KEY ("combo_game_id") REFERENCES "ComboGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ComboWinner" ADD CONSTRAINT "ComboWinner_combo_game_id_fkey"
        FOREIGN KEY ("combo_game_id") REFERENCES "ComboGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
