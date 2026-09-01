-- Accusés d'envoi Expo, une ligne par téléphone visé.
--
-- Migration écrite à la main. Les tables PushCampaign, PushTemplate,
-- PushSegment et ScheduledNotification ont été créées par `prisma db push` et
-- n'ont aucune migration d'origine : un `prisma migrate dev` regénérerait leur
-- CREATE TABLE et casserait le démarrage, l'entrypoint appliquant les
-- migrations au boot.
--
-- Purement additive : nouvelle table, aucune colonne existante touchée.
CREATE TABLE "PushCampaignTicket" (
  "id"              UUID NOT NULL,
  "campaign_id"     UUID NOT NULL,
  "expo_push_token" VARCHAR NOT NULL,
  "receipt_id"      VARCHAR NOT NULL,
  "status"          VARCHAR NOT NULL DEFAULT 'accepted',
  "checked_at"      TIMESTAMP(6),
  "delivered_at"    TIMESTAMP(6),
  "error"           TEXT,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PushCampaignTicket_pkey" PRIMARY KEY ("id")
);

-- Rend l'enregistrement des tickets rejouable sans doublon si un envoi est
-- repris après un incident.
CREATE UNIQUE INDEX "PushCampaignTicket_campaign_id_receipt_id_key"
  ON "PushCampaignTicket"("campaign_id", "receipt_id");

-- Sert la tâche de relecture, qui balaie les tickets acceptés par ancienneté.
CREATE INDEX "PushCampaignTicket_status_created_at_idx"
  ON "PushCampaignTicket"("status", "created_at");

-- Sert le recomptage par campagne.
CREATE INDEX "PushCampaignTicket_campaign_id_status_idx"
  ON "PushCampaignTicket"("campaign_id", "status");

ALTER TABLE "PushCampaignTicket"
  ADD CONSTRAINT "PushCampaignTicket_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "PushCampaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
