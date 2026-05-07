-- ============================================================
-- Migration : ajout du module livreur (Deliverer)
-- Date       : 2026-04-20
-- Ciblée     : 3 enums + 1 table + 5 index + 1 FK → Restaurant
-- Aucune autre table n'est touchée (safe pour données existantes)
-- ============================================================

-- CreateEnum
CREATE TYPE "DelivererStatus" AS ENUM ('PENDING_VALIDATION', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VehiculeType" AS ENUM ('MOTO', 'VELO', 'VOITURE');

-- CreateEnum
CREATE TYPE "Genre" AS ENUM ('HOMME', 'FEMME');

-- CreateTable
CREATE TABLE "Deliverer" (
    "id" UUID NOT NULL,
    "phone" VARCHAR NOT NULL,
    "password" VARCHAR NOT NULL,
    "first_name" VARCHAR(255),
    "last_name" VARCHAR(255),
    "email" VARCHAR,
    "genre" "Genre",
    "image" TEXT,
    "type_vehicule" "VehiculeType",
    "piece_identite" TEXT,
    "permis_conduire" TEXT,
    "status" "DelivererStatus" NOT NULL DEFAULT 'PENDING_VALIDATION',
    "is_operational" BOOLEAN NOT NULL DEFAULT false,
    "restaurant_id" UUID,
    "last_login_at" TIMESTAMP(3),
    "refresh_token" TEXT,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deliverer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deliverer_phone_key" ON "Deliverer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Deliverer_email_key" ON "Deliverer"("email");

-- CreateIndex
CREATE INDEX "Deliverer_phone_idx" ON "Deliverer"("phone");

-- CreateIndex
CREATE INDEX "Deliverer_status_idx" ON "Deliverer"("status");

-- CreateIndex
CREATE INDEX "Deliverer_restaurant_id_idx" ON "Deliverer"("restaurant_id");

-- AddForeignKey
ALTER TABLE "Deliverer" ADD CONSTRAINT "Deliverer_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
