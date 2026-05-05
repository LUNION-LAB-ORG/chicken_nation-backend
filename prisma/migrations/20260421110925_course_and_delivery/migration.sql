-- ============================================================
-- Migration : introduction des modèles Course, Delivery, CourseOfferAttempt
-- Date       : 2026-04-21
--
-- Opérations :
--  1. DROP `Order.deliverer_id` (ajouté récemment, rendu obsolète)
--  2. CREATE 4 enums : CourseStatut, DeliveryStatut, DeliveryFailureReason, CourseOfferStatus
--  3. CREATE tables : Course, Delivery, CourseOfferAttempt
--  4. Indexes + FK vers Deliverer, Restaurant, Order
--
-- Zéro donnée perdue : Order.deliverer_id est vide (flow livraison non implémenté).
-- ============================================================

-- 1. DROP Order.deliverer_id (nettoyage)
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_deliverer_id_fkey";
DROP INDEX IF EXISTS "Order_deliverer_id_idx";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "deliverer_id";

-- 2. CREATE ENUMS

CREATE TYPE "CourseStatut" AS ENUM (
  'PENDING_ASSIGNMENT',
  'ACCEPTED',
  'AT_RESTAURANT',
  'IN_DELIVERY',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE "DeliveryStatut" AS ENUM (
  'PENDING',
  'IN_ROUTE',
  'ARRIVED',
  'DELIVERED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "DeliveryFailureReason" AS ENUM (
  'CLIENT_ABSENT',
  'CLIENT_REFUSED',
  'ADDRESS_NOT_FOUND',
  'CLIENT_UNREACHABLE',
  'WRONG_ORDER',
  'OTHER'
);

CREATE TYPE "CourseOfferStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REFUSED',
  'EXPIRED'
);

-- 3. CREATE TABLE Course

CREATE TABLE "Course" (
  "id"                     UUID          NOT NULL,
  "reference"              VARCHAR(20)   NOT NULL,
  "statut"                 "CourseStatut" NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
  "deliverer_id"           UUID,
  "restaurant_id"          UUID          NOT NULL,
  "assigned_at"            TIMESTAMP(6),
  "picked_up_at"           TIMESTAMP(6),
  "completed_at"           TIMESTAMP(6),
  "cancelled_at"           TIMESTAMP(6),
  "cancelled_by"           VARCHAR,
  "cancelled_reason"       VARCHAR,
  "offer_expires_at"       TIMESTAMP(6),
  "refusal_count"          INTEGER       NOT NULL DEFAULT 0,
  "total_delivery_fee"     DOUBLE PRECISION NOT NULL,
  "estimated_duration_min" INTEGER,
  "created_at"             TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Course_reference_key" ON "Course"("reference");
CREATE INDEX "Course_deliverer_id_statut_idx" ON "Course"("deliverer_id", "statut");
CREATE INDEX "Course_restaurant_id_statut_idx" ON "Course"("restaurant_id", "statut");
CREATE INDEX "Course_statut_offer_expires_at_idx" ON "Course"("statut", "offer_expires_at");

ALTER TABLE "Course"
  ADD CONSTRAINT "Course_deliverer_id_fkey"
  FOREIGN KEY ("deliverer_id")
  REFERENCES "Deliverer"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "Course"
  ADD CONSTRAINT "Course_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id")
  REFERENCES "Restaurant"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- 4. CREATE TABLE Delivery

CREATE TABLE "Delivery" (
  "id"              UUID                    NOT NULL,
  "course_id"       UUID                    NOT NULL,
  "sequence_order"  INTEGER                 NOT NULL,
  "order_id"        UUID                    NOT NULL,
  "statut"          "DeliveryStatut"        NOT NULL DEFAULT 'PENDING',
  "delivery_pin"    VARCHAR(4)              NOT NULL,
  "in_route_at"     TIMESTAMP(6),
  "arrived_at"      TIMESTAMP(6),
  "delivered_at"    TIMESTAMP(6),
  "failed_at"       TIMESTAMP(6),
  "failure_reason"  "DeliveryFailureReason",
  "failure_note"    VARCHAR(500),
  "proof_image"     TEXT,
  "created_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Delivery_order_id_key" ON "Delivery"("order_id");
CREATE UNIQUE INDEX "Delivery_course_id_sequence_order_key" ON "Delivery"("course_id", "sequence_order");
CREATE INDEX "Delivery_course_id_statut_idx" ON "Delivery"("course_id", "statut");
CREATE INDEX "Delivery_order_id_idx" ON "Delivery"("order_id");

ALTER TABLE "Delivery"
  ADD CONSTRAINT "Delivery_course_id_fkey"
  FOREIGN KEY ("course_id")
  REFERENCES "Course"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "Delivery"
  ADD CONSTRAINT "Delivery_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "Order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- 5. CREATE TABLE CourseOfferAttempt

CREATE TABLE "CourseOfferAttempt" (
  "id"              UUID                NOT NULL,
  "course_id"       UUID                NOT NULL,
  "deliverer_id"    UUID                NOT NULL,
  "status"          "CourseOfferStatus" NOT NULL DEFAULT 'PENDING',
  "offered_at"      TIMESTAMP(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"      TIMESTAMP(6)        NOT NULL,
  "responded_at"    TIMESTAMP(6),
  "refusal_reason"  VARCHAR(500),
  "created_at"      TIMESTAMP(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseOfferAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourseOfferAttempt_deliverer_id_status_idx" ON "CourseOfferAttempt"("deliverer_id", "status");
CREATE INDEX "CourseOfferAttempt_course_id_idx" ON "CourseOfferAttempt"("course_id");
CREATE INDEX "CourseOfferAttempt_status_expires_at_idx" ON "CourseOfferAttempt"("status", "expires_at");

ALTER TABLE "CourseOfferAttempt"
  ADD CONSTRAINT "CourseOfferAttempt_course_id_fkey"
  FOREIGN KEY ("course_id")
  REFERENCES "Course"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "CourseOfferAttempt"
  ADD CONSTRAINT "CourseOfferAttempt_deliverer_id_fkey"
  FOREIGN KEY ("deliverer_id")
  REFERENCES "Deliverer"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
