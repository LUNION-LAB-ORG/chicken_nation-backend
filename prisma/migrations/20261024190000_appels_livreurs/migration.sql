-- Appels dans l'appli avec les livreurs (demande du 24/10).
--
-- Le livreur appelle le service client depuis son appli, le service client
-- appelle un livreur. Un appel a désormais pour appelant un membre du
-- personnel (`caller_id`, comme avant) OU un livreur (`caller_deliverer_id`),
-- et peut cibler un livreur (`target_deliverer_id`). La course et la commande
-- dont il est question sont gardées pour l'historique.
--
-- Rejouable, sans reprise de données. Seul changement sur l'existant : la
-- colonne `caller_id` (et `caller_type`) accepte NULL, ce que l'ancien serveur
-- ignore (il la renseigne toujours). Les appels existants ne changent pas.

ALTER TABLE "calls" ALTER COLUMN "caller_id" DROP NOT NULL;
ALTER TABLE "calls" ALTER COLUMN "caller_type" DROP NOT NULL;

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "caller_deliverer_id" UUID;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "target_deliverer_id" UUID;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "course_id" UUID;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "order_id" UUID;

CREATE INDEX IF NOT EXISTS "calls_caller_deliverer_id_idx" ON "calls"("caller_deliverer_id");
CREATE INDEX IF NOT EXISTS "calls_target_deliverer_id_idx" ON "calls"("target_deliverer_id");

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_deliverer_id_fkey"
    FOREIGN KEY ("caller_deliverer_id") REFERENCES "Deliverer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_target_deliverer_id_fkey"
    FOREIGN KEY ("target_deliverer_id") REFERENCES "Deliverer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
