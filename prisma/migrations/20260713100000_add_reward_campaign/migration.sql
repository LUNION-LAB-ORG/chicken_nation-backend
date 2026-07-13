-- Campagnes « Envoyer un cadeau » (Reward v2). Idempotent (anti-drift Neon).

CREATE TABLE IF NOT EXISTS "RewardCampaign" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"           VARCHAR      NOT NULL,
    "type"           "RewardType" NOT NULL,
    "payload"        JSONB        NOT NULL,
    "target_type"    VARCHAR      NOT NULL,
    "target_config"  JSONB        NOT NULL,
    "expires_at"     TIMESTAMP(6),
    "total_targeted" INTEGER      NOT NULL DEFAULT 0,
    "status"         VARCHAR      NOT NULL DEFAULT 'sent',
    "scheduled_at"   TIMESTAMP(6),
    "sent_at"        TIMESTAMP(6),
    "created_by"     VARCHAR      NOT NULL,
    "created_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RewardCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RewardCampaign_status_scheduled_at_idx"
    ON "RewardCampaign" ("status", "scheduled_at");

ALTER TABLE "Reward" ADD COLUMN IF NOT EXISTS "campaign_id" UUID;

CREATE INDEX IF NOT EXISTS "Reward_campaign_id_status_idx"
    ON "Reward" ("campaign_id", "status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Reward_campaign_id_fkey'
    ) THEN
        ALTER TABLE "Reward"
            ADD CONSTRAINT "Reward_campaign_id_fkey"
            FOREIGN KEY ("campaign_id") REFERENCES "RewardCampaign"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
