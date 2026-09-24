-- REMISE EN ORDRE DU MODULE CAMPAGNES après l'incident du 24/09.
--
-- `20260924133624_init_crm_campaigns` a été marquée appliquée en production
-- (`migrate resolve --applied`) sans avoir tourné : les tables et colonnes y
-- ont été posées à la main. Deux conséquences que cette migration corrige :
--
--   1. Le fichier d'origine ne crée ni `Prospect.assigned_to_id`, ni ne rend
--      `Prospect.restaurant_id` facultatif, alors que `schema.prisma` l'exige.
--      La production les a, une base neuve ne les aurait pas.
--   2. Aucune des sept clés étrangères du module n'existe en production, et
--      celle de `Prospect.restaurant_id`, présente depuis juin, a disparu.
--
-- Tout est rejouable sans effet. Chaque clé étrangère a son bloc : une ligne
-- orpheline laisse un NOTICE au lieu de faire échouer la migration, parce que
-- l'entrypoint applique les migrations avec `set -e` et qu'un échec bloque le
-- démarrage du backend (c'est ce qui a coupé l'API le 24/09).
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "assigned_to_id" UUID;
ALTER TABLE "Prospect" ALTER COLUMN "restaurant_id" DROP NOT NULL;

DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'Prospect_restaurant_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'Prospect_campaign_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'Prospect_assigned_to_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_loss_reason_id_fkey" FOREIGN KEY ("loss_reason_id") REFERENCES "ProspectLossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'Prospect_loss_reason_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "ConversionCampaign" ADD CONSTRAINT "ConversionCampaign_lead_agent_id_fkey" FOREIGN KEY ("lead_agent_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'ConversionCampaign_lead_agent_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'CampaignAgent_campaign_id_fkey non posée : lignes orphelines';
END $$;

DO $$ BEGIN
    ALTER TABLE "CampaignAgent" ADD CONSTRAINT "CampaignAgent_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN foreign_key_violation THEN RAISE NOTICE 'CampaignAgent_agent_id_fkey non posée : lignes orphelines';
END $$;
