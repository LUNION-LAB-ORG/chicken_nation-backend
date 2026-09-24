-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PLANIFIED', 'ACTIVE', 'COMPLETED', 'SUSPENDED');

-- AlterEnum
ALTER TYPE "ProspectPlatform" ADD VALUE 'APP_ORGANIC';

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "campaign_id" UUID,
ADD COLUMN     "loss_reason_id" UUID;

-- CreateTable
CREATE TABLE "ConversionCampaign" (
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
CREATE TABLE "CampaignAgent" (
    "campaign_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,

    CONSTRAINT "CampaignAgent_pkey" PRIMARY KEY ("campaign_id","agent_id")
);

-- CreateTable
CREATE TABLE "ProspectLossReason" (
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

-- CreateTable
CREATE TABLE "ProspectCall" (
    "id" UUID NOT NULL,
    "result" "CallResult" NOT NULL,
    "rank" INTEGER NOT NULL,
    "note" TEXT,
    "agent_id" UUID,
    "prospect_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectCall_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_loss_reason_id_fkey" FOREIGN KEY ("loss_reason_id") REFERENCES "ProspectLossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionCampaign" ADD CONSTRAINT "ConversionCampaign_lead_agent_id_fkey" FOREIGN KEY ("lead_agent_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectCall" ADD CONSTRAINT "ProspectCall_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectCall" ADD CONSTRAINT "ProspectCall_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
