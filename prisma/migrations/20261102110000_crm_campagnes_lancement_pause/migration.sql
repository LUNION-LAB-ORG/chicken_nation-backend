-- Campagnes du CRM : lancement automatique, durée comptée depuis le
-- lancement, suspension suivie (analyse du 02/11, problèmes 3, 7, 13 et 23).
--
--  - "duration_days" : « Après N jours ». La fin se calcule au lancement, et
--    non plus depuis la date de début saisie.
--  - "suspended_at", "suspension_alert_sent_at" : début de la suspension en
--    cours et alerte envoyée à la direction (une seule par suspension).
--  - "launch_error", "launch_failed_at" : refus et panne du lancement
--    automatique, affichés sur la carte de la campagne.
--
-- Additive et rejouable : colonnes facultatives sans valeur par défaut
-- (instantanées). L'ancien serveur les ignore.
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "duration_days" INTEGER;
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP(6);
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "suspension_alert_sent_at" TIMESTAMP(6);
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "launch_error" VARCHAR(255);
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "launch_failed_at" TIMESTAMP(6);

-- Campagnes déjà suspendues : la vraie date de suspension n'est pas connue.
-- La dernière écriture est la suspension dans le cas courant. Rejouable : seules
-- les lignes encore sans date sont touchées.
UPDATE "ConversionCampaign" SET "suspended_at" = "updated_at"
WHERE "status" = 'SUSPENDED' AND "suspended_at" IS NULL;

-- Campagnes planifiées AVANT le lancement automatique, dont la date de début
-- est déjà passée : personne n'a décidé de les lancer (essai oublié, campagne
-- abandonnée). Lancées seules au premier passage de la tâche, elles prendraient
-- des contacts que des agents suivent déjà. Elles attendent un clic sur
-- « Lancer », et leur carte le dit. Le clic, ou une modification de la
-- campagne, efface la mention ; les campagnes à venir se lancent seules.
-- Une campagne dont la date de fin est passée est close par la tâche des
-- clôtures, comme les autres.
-- Mesure avant le déploiement (lecture seule) :
--   SELECT "id", "name", "start_date", "end_date" FROM "ConversionCampaign"
--   WHERE "status" = 'PLANIFIED' AND "entity_status" <> 'DELETED' AND "start_date" <= now();
UPDATE "ConversionCampaign"
SET "launch_error" = 'Prévue avant le lancement automatique : lancez-la à la main', "launch_failed_at" = now()
WHERE "status" = 'PLANIFIED' AND "entity_status" <> 'DELETED' AND "start_date" <= now()
  AND "launch_failed_at" IS NULL;
