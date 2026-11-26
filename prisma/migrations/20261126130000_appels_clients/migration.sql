-- Appels dans l'appli avec les clients (demande du 26/11).
--
-- Depuis l'appli Chicken Nation, le client appelle le service client ou le
-- livreur de sa commande ; le service client appelle un client dans l'appli.
-- Un appel peut donc avoir pour appelant un client (`caller_customer_id`) et
-- cibler un client (`target_customer_id`, `target_kind` = 'CUSTOMER').
--
-- `Customer.appels_appli_at` : dernière fois que l'appli du client a dit
-- pouvoir prendre un appel. Vide (toutes les applis installées avant cette
-- version) : le service client appelle au téléphone.
--
-- Rejouable, sans reprise de données : uniquement des colonnes facultatives,
-- que l'ancien serveur ignore.

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "caller_customer_id" UUID;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "target_customer_id" UUID;

CREATE INDEX IF NOT EXISTS "calls_caller_customer_id_idx" ON "calls"("caller_customer_id");
CREATE INDEX IF NOT EXISTS "calls_target_customer_id_idx" ON "calls"("target_customer_id");

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_customer_id_fkey"
    FOREIGN KEY ("caller_customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_target_customer_id_fkey"
    FOREIGN KEY ("target_customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "appels_appli_at" TIMESTAMP(3);
