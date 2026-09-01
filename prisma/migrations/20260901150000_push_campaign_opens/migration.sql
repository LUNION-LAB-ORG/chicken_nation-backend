-- Ouvertures de notification, remontées par le téléphone.
--
-- Migration écrite à la main (dérive `db push` sur les tables de campagnes).
-- Purement additive.
ALTER TABLE "PushCampaign" ADD COLUMN "total_opened" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PushCampaignOpen" (
  "id"          UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "customer_id" UUID,
  "platform"    VARCHAR,
  "opened_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PushCampaignOpen_pkey" PRIMARY KEY ("id")
);

-- Un client ne compte qu'une fois par campagne. Les ouvertures anonymes
-- (customer_id nul) échappent à cette contrainte, Postgres traitant chaque NULL
-- comme distinct : c'est voulu, on ne peut pas les dédoublonner.
CREATE UNIQUE INDEX "PushCampaignOpen_campaign_id_customer_id_key"
  ON "PushCampaignOpen"("campaign_id", "customer_id");

CREATE INDEX "PushCampaignOpen_campaign_id_idx"
  ON "PushCampaignOpen"("campaign_id");

ALTER TABLE "PushCampaignOpen"
  ADD CONSTRAINT "PushCampaignOpen_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "PushCampaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
