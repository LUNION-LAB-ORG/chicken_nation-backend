-- Gratte & Gagne (moteur) — tables ScratchLot + ScratchDraw.
-- Le grattage est un CANAL DE PRÉSENTATION du Reward existant : le lot PLANCHER
-- révèle les points de base (coût enveloppe = 0), les GROS LOTS sont des bonus
-- rares comptés dans l'enveloppe (unit_cost). Migration idempotente.

-- 1) ScratchLot
CREATE TABLE IF NOT EXISTS "ScratchLot" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "label"        VARCHAR NOT NULL,
  "reward_type"  "RewardType" NOT NULL,
  "payload"      JSONB NOT NULL,
  "weight"       INTEGER NOT NULL DEFAULT 1,
  "unit_cost"    INTEGER NOT NULL DEFAULT 0,
  "min_cart"     INTEGER NOT NULL DEFAULT 0,
  "frequency_cap" INTEGER,
  "stock"        INTEGER,
  "stock_used"   INTEGER NOT NULL DEFAULT 0,
  "level_min"    "LoyaltyLevel",
  "is_floor"     BOOLEAN NOT NULL DEFAULT false,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScratchLot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScratchLot_active_is_floor_idx" ON "ScratchLot" ("active", "is_floor");
CREATE INDEX IF NOT EXISTS "ScratchLot_reward_type_idx" ON "ScratchLot" ("reward_type");

-- 2) ScratchDraw
CREATE TABLE IF NOT EXISTS "ScratchDraw" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id"       UUID NOT NULL,
  "customer_id"    UUID NOT NULL,
  "scratch_lot_id" UUID,
  "reward_id"      UUID,
  "cost"           INTEGER NOT NULL DEFAULT 0,
  "restored_at"    TIMESTAMP(6),
  "created_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScratchDraw_pkey" PRIMARY KEY ("id")
);

-- Idempotent : ajoute restored_at si la table préexistait (CREATE TABLE IF NOT EXISTS
-- ci-dessus n'aurait pas ajouté la colonne à une table déjà présente).
ALTER TABLE "ScratchDraw" ADD COLUMN IF NOT EXISTS "restored_at" TIMESTAMP(6);

-- 1 tirage par commande → idempotence du moteur (garantie DB, pas seulement applicative).
CREATE UNIQUE INDEX IF NOT EXISTS "ScratchDraw_order_id_key" ON "ScratchDraw" ("order_id");
CREATE INDEX IF NOT EXISTS "ScratchDraw_customer_id_created_at_idx" ON "ScratchDraw" ("customer_id", "created_at");
CREATE INDEX IF NOT EXISTS "ScratchDraw_scratch_lot_id_created_at_idx" ON "ScratchDraw" ("scratch_lot_id", "created_at");
CREATE INDEX IF NOT EXISTS "ScratchDraw_created_at_idx" ON "ScratchDraw" ("created_at");

-- 3) FKs (gardées par des checks pour rester idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScratchDraw_order_id_fkey') THEN
    ALTER TABLE "ScratchDraw" ADD CONSTRAINT "ScratchDraw_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScratchDraw_customer_id_fkey') THEN
    ALTER TABLE "ScratchDraw" ADD CONSTRAINT "ScratchDraw_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScratchDraw_scratch_lot_id_fkey') THEN
    ALTER TABLE "ScratchDraw" ADD CONSTRAINT "ScratchDraw_scratch_lot_id_fkey"
      FOREIGN KEY ("scratch_lot_id") REFERENCES "ScratchLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScratchDraw_reward_id_fkey') THEN
    ALTER TABLE "ScratchDraw" ADD CONSTRAINT "ScratchDraw_reward_id_fkey"
      FOREIGN KEY ("reward_id") REFERENCES "Reward"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- 4) SEED du lot PLANCHER (is_floor=true, POINTS). Garantit la continuité du
--    comportement actuel : si AUCUN gros lot n'est configuré, chaque commande
--    reçoit le plancher = révélation des points de base (coût enveloppe = 0).
--    Le payload {points} est ignoré par le moteur pour le plancher : ce sont
--    TOUJOURS les earnedPoints réels de la commande qui sont révélés.
INSERT INTO "ScratchLot" ("id", "label", "reward_type", "payload", "weight", "unit_cost", "min_cart", "is_floor", "active")
SELECT gen_random_uuid(), 'Points de la commande', 'POINTS', '{"points": 0}'::jsonb, 1, 0, 0, true, true
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE "is_floor" = true);
