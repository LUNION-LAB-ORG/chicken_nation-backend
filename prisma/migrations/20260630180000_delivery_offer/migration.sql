-- Offres de livraison : enums + tables (idempotent, additif, zéro perte de données).

-- 1. Enums (idempotents)
DO $$ BEGIN
  CREATE TYPE "DeliveryOfferType" AS ENUM ('FREE_DELIVERY', 'PERCENTAGE', 'FIXED_AMOUNT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryOfferChannel" AS ENUM ('APP', 'CALL_CENTER', 'BOTH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Table DeliveryOffer
CREATE TABLE IF NOT EXISTS "DeliveryOffer" (
  "id"                 UUID NOT NULL,
  "name"               VARCHAR NOT NULL,
  "description"        TEXT,
  "type"               "DeliveryOfferType" NOT NULL,
  "value"              DOUBLE PRECISION NOT NULL DEFAULT 0,
  "min_order_amount"   DOUBLE PRECISION DEFAULT 0,
  "channel"            "DeliveryOfferChannel" NOT NULL DEFAULT 'BOTH',
  "restaurant_ids"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "target_standard"    BOOLEAN NOT NULL DEFAULT false,
  "target_premium"     BOOLEAN NOT NULL DEFAULT false,
  "target_gold"        BOOLEAN NOT NULL DEFAULT false,
  "days_of_week"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "time_start"         VARCHAR,
  "time_end"           VARCHAR,
  "start_date"         TIMESTAMP(6) NOT NULL,
  "expiration_date"    TIMESTAMP(6) NOT NULL,
  "max_usage"          INTEGER,
  "max_usage_per_user" INTEGER DEFAULT 0,
  "usage_count"        INTEGER NOT NULL DEFAULT 0,
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "priority"           INTEGER NOT NULL DEFAULT 0,
  "created_by"         UUID,
  "created_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "entity_status"      "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "DeliveryOffer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeliveryOffer_is_active_entity_status_idx"
  ON "DeliveryOffer" ("is_active", "entity_status");
CREATE INDEX IF NOT EXISTS "DeliveryOffer_start_date_expiration_date_idx"
  ON "DeliveryOffer" ("start_date", "expiration_date");

-- 3. Table DeliveryOfferUsage
CREATE TABLE IF NOT EXISTS "DeliveryOfferUsage" (
  "id"                UUID NOT NULL,
  "delivery_offer_id" UUID NOT NULL,
  "customer_id"       UUID NOT NULL,
  "order_id"          UUID,
  "discount_amount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status"            "PromoCodeUsageStatus" NOT NULL DEFAULT 'INACTIVE',
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryOfferUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeliveryOfferUsage_delivery_offer_id_idx"
  ON "DeliveryOfferUsage" ("delivery_offer_id");
CREATE INDEX IF NOT EXISTS "DeliveryOfferUsage_customer_id_idx"
  ON "DeliveryOfferUsage" ("customer_id");
CREATE INDEX IF NOT EXISTS "DeliveryOfferUsage_order_id_idx"
  ON "DeliveryOfferUsage" ("order_id");
