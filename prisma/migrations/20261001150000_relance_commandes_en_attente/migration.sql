-- RELANCE DES COMMANDES EN ATTENTE (paniers de l'application non payés).
--
-- Deux tables neuves, rien n'est modifié sur "Order" ni sur "User" :
--  - "OrderRelance" : une ligne par commande ayant connu une alerte ou un geste
--    d'agent (prise « Je m'en occupe », ignorée pour toute l'équipe). L'état
--    « à relancer » se calcule à la lecture ; la prise expire d'elle même.
--  - "OrderRelanceJournal" : historique des gestes, jamais modifié.
--
-- ON DELETE CASCADE sur la commande, SET NULL sur l'agent (un compte supprimé
-- ne doit pas effacer l'historique).
--
-- `IF NOT EXISTS` partout : l'entrypoint applique les migrations avec `set -e`.
-- Rejouable sans effet. Noms alignés sur ceux que Prisma produit.

CREATE TABLE IF NOT EXISTS "OrderRelance" (
  "id"              UUID          NOT NULL,
  "order_id"        UUID          NOT NULL,
  "alerte_le"       TIMESTAMP(6),
  "pris_par_id"     UUID,
  "pris_le"         TIMESTAMP(6),
  "prise_expire_le" TIMESTAMP(6),
  "ignore_par_id"   UUID,
  "ignore_le"       TIMESTAMP(6),
  "raison_code"     VARCHAR(40),
  "raison_texte"    VARCHAR(160),
  "created_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderRelance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderRelance_order_id_key"
  ON "OrderRelance" ("order_id");
CREATE INDEX IF NOT EXISTS "OrderRelance_alerte_le_idx"
  ON "OrderRelance" ("alerte_le");
-- Liste « Ignorées » des dernières 24 h.
CREATE INDEX IF NOT EXISTS "OrderRelance_ignore_le_idx"
  ON "OrderRelance" ("ignore_le");

CREATE TABLE IF NOT EXISTS "OrderRelanceJournal" (
  "id"         UUID          NOT NULL,
  "order_id"   UUID          NOT NULL,
  "action"     VARCHAR(20)   NOT NULL,
  "user_id"    UUID,
  "raison"     VARCHAR(200),
  "created_at" TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderRelanceJournal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderRelanceJournal_order_id_created_at_idx"
  ON "OrderRelanceJournal" ("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "OrderRelanceJournal_user_id_created_at_idx"
  ON "OrderRelanceJournal" ("user_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderRelance_order_id_fkey') THEN
    ALTER TABLE "OrderRelance" ADD CONSTRAINT "OrderRelance_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderRelance_pris_par_id_fkey') THEN
    ALTER TABLE "OrderRelance" ADD CONSTRAINT "OrderRelance_pris_par_id_fkey"
      FOREIGN KEY ("pris_par_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderRelance_ignore_par_id_fkey') THEN
    ALTER TABLE "OrderRelance" ADD CONSTRAINT "OrderRelance_ignore_par_id_fkey"
      FOREIGN KEY ("ignore_par_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderRelanceJournal_order_id_fkey') THEN
    ALTER TABLE "OrderRelanceJournal" ADD CONSTRAINT "OrderRelanceJournal_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderRelanceJournal_user_id_fkey') THEN
    ALTER TABLE "OrderRelanceJournal" ADD CONSTRAINT "OrderRelanceJournal_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
