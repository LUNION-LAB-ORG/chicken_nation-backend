-- Statut de délivrance SMS d'un message prospect (envoyé réellement par Twilio ?).
ALTER TABLE "ProspectMessage" ADD COLUMN IF NOT EXISTS "sms_sent" BOOLEAN NOT NULL DEFAULT false;
