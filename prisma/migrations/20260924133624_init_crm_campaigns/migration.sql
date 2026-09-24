-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CampaignStatus" AS ENUM ('PLANIFIED', 'ACTIVE', 'COMPLETED', 'SUSPENDED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterEnum
ALTER TYPE "ProspectPlatform" ADD VALUE IF NOT EXISTS 'APP_ORGANIC';

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "campaign_id" UUID,
ADD COLUMN IF NOT EXISTS "loss_reason_id" UUID;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionCampaign" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "start_date" TIMESTAMP(6) NOT NULL,
    "end_date" TIMESTAMP(6),
    "status" "CampaignStatus" NOT NULL DEFAULT 'PLANIFIED',
    "target_conversion_rate" DOUBLE PRECISION,
    "target_contacts_count" INTEGER,
    "lead_agent_id" UUID NOT NULL,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CampaignAgent" (
    "campaign_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,

    CONSTRAINT "CampaignAgent_pkey" PRIMARY KEY ("campaign_id","agent_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProspectLossReason" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectLossReason_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_loss_reason_id_fkey" FOREIGN KEY ("loss_reason_id") REFERENCES "ProspectLossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaign" ADD CONSTRAINT "ConversionCampaign_lead_agent_id_fkey" FOREIGN KEY ("lead_agent_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

