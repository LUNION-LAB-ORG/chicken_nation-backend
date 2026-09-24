-- MODULE PROSPECTS : conversion des inscrits qui n'ont jamais commandé.
--
-- Un prospect est un client inscrit sans commande « effective » : une commande
-- non supprimée qui n'est pas un paiement en ligne encore en attente. Cette
-- définition retrouve les 9 464 inscrits sans commande du cahier des charges
-- (9 454 au 23/09 au soir).
--
-- Migration ADDITIVE uniquement : nouvelles tables, nouvelles colonnes sur
-- ConversionCampaign, insertions dans des tables vides. Aucune suppression,
-- aucune ligne existante modifiée. Les colonnes `campaign_id`,
-- `assigned_to_id` et `loss_reason_id` de "Prospect" restent en place, vides :
-- le code déployé juste avant les lit encore, les retirer ici casserait l'API
-- pendant la bascule. Elles partiront dans une migration à part.
--
-- Tout est rejouable sans effet (IF NOT EXISTS, duplicate_object, NOT EXISTS) :
-- l'entrypoint applique les migrations avec `set -e` et un échec bloque le
-- démarrage du backend.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CampaignDistributionMode" AS ENUM ('AUTOMATIQUE', 'MANUEL');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ConversionProspectStatus" AS ENUM ('A_APPELER', 'A_RAPPELER', 'INTERESSE', 'COUPON_ENVOYE', 'NON_INTERESSE', 'INJOIGNABLE', 'CONVERTI');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ConversionCallOutcome" AS ENUM ('NON_JOINT', 'A_RAPPELER', 'INTERESSE', 'NON_INTERESSE', 'NUMERO_INVALIDE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ConversionCouponChannel" AS ENUM ('WHATSAPP', 'SMS', 'AUCUN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ConversionReleaseReason" AS ENUM ('CONVERTI', 'FIN_CAMPAGNE', 'RETIRE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ConversionEventType" AS ENUM ('ENTREE', 'ASSIGNATION', 'APPEL', 'COUPON', 'COUPON_RENVOYE', 'CAMPAGNE_ENTREE', 'CAMPAGNE_SORTIE', 'CONVERSION', 'RETOUR', 'ALERTE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "ConversionCampaign" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "created_by_id" UUID,
ADD COLUMN IF NOT EXISTS "distribution_mode" "CampaignDistributionMode" NOT NULL DEFAULT 'AUTOMATIQUE',
ADD COLUMN IF NOT EXISTS "offer_id" UUID,
ADD COLUMN IF NOT EXISTS "registered_from" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "registered_to" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "report" JSONB,
ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "targeted_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionCallStatus" (
    "id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "outcome" "ConversionCallOutcome" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionCallStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionOffer" (
    "id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" DOUBLE PRECISION NOT NULL,
    "max_discount_amount" DOUBLE PRECISION,
    "min_order_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "validity_days" INTEGER NOT NULL DEFAULT 7,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionProspect" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "registered_at" TIMESTAMP(6) NOT NULL,
    "status" "ConversionProspectStatus" NOT NULL DEFAULT 'A_APPELER',
    "assigned_to_id" UUID,
    "assigned_at" TIMESTAMP(6),
    "campaign_id" UUID,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "last_call_at" TIMESTAMP(6),
    "last_call_status_id" UUID,
    "last_call_outcome" "ConversionCallOutcome",
    "first_reached_at" TIMESTAMP(6),
    "qualified_at" TIMESTAMP(6),
    "callback_at" TIMESTAMP(6),
    "loss_reason_id" UUID,
    "last_comment" TEXT,
    "coupon_sent_at" TIMESTAMP(6),
    "converted_at" TIMESTAMP(6),
    "first_order_id" UUID,
    "first_order_amount" DOUBLE PRECISION,
    "abandoned_orders" INTEGER NOT NULL DEFAULT 0,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionCall" (
    "id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "agent_id" UUID,
    "campaign_id" UUID,
    "call_status_id" UUID,
    "status_label" VARCHAR(120) NOT NULL,
    "outcome" "ConversionCallOutcome" NOT NULL,
    "reached" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "loss_reason_id" UUID,
    "comment" TEXT,
    "callback_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionCoupon" (
    "id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "campaign_id" UUID,
    "offer_id" UUID,
    "promo_code_id" UUID NOT NULL,
    "code" VARCHAR NOT NULL,
    "offer_label" VARCHAR(120) NOT NULL,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" DOUBLE PRECISION NOT NULL,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "channel" "ConversionCouponChannel" NOT NULL DEFAULT 'AUCUN',
    "message_sid" VARCHAR,
    "send_error" TEXT,
    "resent_count" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMP(6),
    "order_id" UUID,
    "order_amount" DOUBLE PRECISION,

    CONSTRAINT "ConversionCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionCampaignMember" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "agent_id" UUID,
    "assigned_at" TIMESTAMP(6),
    "joined_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(6),
    "release_reason" "ConversionReleaseReason",
    "converted_at" TIMESTAMP(6),
    "alert_sent_at" TIMESTAMP(6),

    CONSTRAINT "ConversionCampaignMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionEvent" (
    "id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "type" "ConversionEventType" NOT NULL,
    "actor_id" UUID,
    "campaign_id" UUID,
    "label" VARCHAR(255) NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversionExport" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "filters" JSONB,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConversionProspect_customer_id_key" ON "ConversionProspect"("customer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_status_registered_at_idx" ON "ConversionProspect"("status", "registered_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_assigned_to_id_status_idx" ON "ConversionProspect"("assigned_to_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_campaign_id_status_idx" ON "ConversionProspect"("campaign_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_last_call_at_idx" ON "ConversionProspect"("last_call_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_converted_at_idx" ON "ConversionProspect"("converted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionProspect_registered_at_idx" ON "ConversionProspect"("registered_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCall_prospect_id_created_at_idx" ON "ConversionCall"("prospect_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCall_campaign_id_created_at_idx" ON "ConversionCall"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCall_agent_id_created_at_idx" ON "ConversionCall"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCall_created_at_idx" ON "ConversionCall"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConversionCoupon_promo_code_id_key" ON "ConversionCoupon"("promo_code_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCoupon_prospect_id_sent_at_idx" ON "ConversionCoupon"("prospect_id", "sent_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCoupon_campaign_id_idx" ON "ConversionCoupon"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCoupon_sent_at_idx" ON "ConversionCoupon"("sent_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCoupon_used_at_idx" ON "ConversionCoupon"("used_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCoupon_code_idx" ON "ConversionCoupon"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCampaignMember_campaign_id_agent_id_idx" ON "ConversionCampaignMember"("campaign_id", "agent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCampaignMember_prospect_id_idx" ON "ConversionCampaignMember"("prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConversionCampaignMember_campaign_id_prospect_id_key" ON "ConversionCampaignMember"("campaign_id", "prospect_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionEvent_prospect_id_created_at_idx" ON "ConversionEvent"("prospect_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionExport_created_at_idx" ON "ConversionExport"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversionCampaign_status_idx" ON "ConversionCampaign"("status");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaign" ADD CONSTRAINT "ConversionCampaign_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "ConversionOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaign" ADD CONSTRAINT "ConversionCampaign_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionProspect" ADD CONSTRAINT "ConversionProspect_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionProspect" ADD CONSTRAINT "ConversionProspect_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionProspect" ADD CONSTRAINT "ConversionProspect_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionProspect" ADD CONSTRAINT "ConversionProspect_last_call_status_id_fkey" FOREIGN KEY ("last_call_status_id") REFERENCES "ConversionCallStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionProspect" ADD CONSTRAINT "ConversionProspect_loss_reason_id_fkey" FOREIGN KEY ("loss_reason_id") REFERENCES "ProspectLossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCall" ADD CONSTRAINT "ConversionCall_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "ConversionProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCall" ADD CONSTRAINT "ConversionCall_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCall" ADD CONSTRAINT "ConversionCall_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCall" ADD CONSTRAINT "ConversionCall_call_status_id_fkey" FOREIGN KEY ("call_status_id") REFERENCES "ConversionCallStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCall" ADD CONSTRAINT "ConversionCall_loss_reason_id_fkey" FOREIGN KEY ("loss_reason_id") REFERENCES "ProspectLossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCoupon" ADD CONSTRAINT "ConversionCoupon_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "ConversionProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCoupon" ADD CONSTRAINT "ConversionCoupon_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCoupon" ADD CONSTRAINT "ConversionCoupon_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "ConversionOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCoupon" ADD CONSTRAINT "ConversionCoupon_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCoupon" ADD CONSTRAINT "ConversionCoupon_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaignMember" ADD CONSTRAINT "ConversionCampaignMember_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaignMember" ADD CONSTRAINT "ConversionCampaignMember_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "ConversionProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionCampaignMember" ADD CONSTRAINT "ConversionCampaignMember_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "ConversionProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ConversionExport" ADD CONSTRAINT "ConversionExport_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- LISTES DE DÉPART (modifiables ensuite dans les réglages du module)
-- ============================================================
-- Posées seulement si la liste est vide : un réglage déjà fait n'est jamais
-- écrasé. Le fichier Excel de référence cité par le cahier remplacera ces
-- libellés s'il diffère.

INSERT INTO "ConversionCallStatus" ("id", "label", "outcome", "position")
SELECT gen_random_uuid(), v.label, v.outcome::"ConversionCallOutcome", v.position
FROM (VALUES
    ('Pas de réponse', 'NON_JOINT', 1),
    ('Messagerie vocale', 'NON_JOINT', 2),
    ('Occupé ou a raccroché', 'NON_JOINT', 3),
    ('Joint : intéressé', 'INTERESSE', 4),
    ('Joint : à rappeler', 'A_RAPPELER', 5),
    ('Joint : pas intéressé', 'NON_INTERESSE', 6),
    ('Numéro invalide', 'NUMERO_INVALIDE', 7)
) AS v(label, outcome, position)
WHERE NOT EXISTS (SELECT 1 FROM "ConversionCallStatus");

INSERT INTO "ProspectLossReason" ("id", "name", "position")
SELECT gen_random_uuid(), v.name, v.position
FROM (VALUES
    ('Frais de livraison trop élevés', 1),
    ('Prix des plats', 2),
    ('Zone non desservie', 3),
    ('Problème de paiement', 4),
    ('Problème avec l''application', 5),
    ('Préfère commander par téléphone ou sur place', 6),
    ('Commande déjà sur Glovo ou Yango', 7),
    ('Délai de livraison trop long', 8),
    ('Pas encore eu l''occasion', 9),
    ('Autre', 10)
) AS v(name, position)
WHERE NOT EXISTS (SELECT 1 FROM "ProspectLossReason");

-- Offre de départ : celle déjà réglée pour les coupons Glovo/Yango, pour que le
-- call center propose la même remise qu'aujourd'hui tant que rien n'est changé.
INSERT INTO "ConversionOffer" ("id", "label", "discount_type", "discount_value", "validity_days", "position")
SELECT gen_random_uuid(),
       (CASE WHEN t.valeur = trunc(t.valeur) THEN trunc(t.valeur)::bigint::text ELSE t.valeur::text END)
       || CASE WHEN t.type = 'FIXED_AMOUNT' THEN ' F' ELSE ' %' END
       || ' sur la première commande',
       t.type::"DiscountType", t.valeur, t.jours, 1
FROM (
    SELECT
        CASE WHEN (SELECT value FROM settings WHERE key = 'prospect.coupon_discount_type') = 'FIXED_AMOUNT'
             THEN 'FIXED_AMOUNT' ELSE 'PERCENTAGE' END AS type,
        COALESCE((SELECT value::float FROM settings WHERE key = 'prospect.coupon_discount_value'
                  AND value ~ '^[0-9]+(\.[0-9]+)?$' AND value::float > 0), 10) AS valeur,
        COALESCE((SELECT value::int FROM settings WHERE key = 'prospect.coupon_validity_days'
                  AND value ~ '^[0-9]+$' AND value::int > 0), 7) AS jours
) AS t
WHERE NOT EXISTS (SELECT 1 FROM "ConversionOffer");

-- ============================================================
-- REPRISE DE L'EXISTANT : un prospect par inscrit sans commande effective
-- ============================================================
WITH nouveaux AS (
    INSERT INTO "ConversionProspect" ("id", "customer_id", "registered_at", "abandoned_orders")
    SELECT gen_random_uuid(), c."id", c."created_at",
           (SELECT count(*) FROM "Order" o WHERE o."customer_id" = c."id" AND o."entity_status" = 'DELETED')
    FROM "Customer" c
    WHERE c."entity_status" <> 'DELETED'
      AND NOT EXISTS (
          SELECT 1 FROM "Order" o
          WHERE o."customer_id" = c."id"
            AND o."entity_status" <> 'DELETED'
            AND NOT (o."payment_method" = 'ONLINE' AND o."paied" = false AND o."status" = 'PENDING')
      )
    ON CONFLICT ("customer_id") DO NOTHING
    RETURNING "id"
)
INSERT INTO "ConversionEvent" ("id", "prospect_id", "type", "label")
SELECT gen_random_uuid(), n."id", 'ENTREE', 'Inscrit sans commande (reprise à l''ouverture du module)'
FROM nouveaux n;
