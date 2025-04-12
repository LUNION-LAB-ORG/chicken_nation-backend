-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('NEW', 'ACTIVE', 'INACTIVE', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER', 'PROMOTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DELIVERY', 'PICKUP', 'TABLE');

-- CreateEnum
CREATE TYPE "PaiementMode" AS ENUM ('MOBILE_MONEY', 'CREDIT_CARD', 'CASH');

-- CreateEnum
CREATE TYPE "PaiementMobileMoneyType" AS ENUM ('ORANGE', 'MTN', 'MOOV');

-- CreateEnum
CREATE TYPE "PaiementStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "SupplementCategory" AS ENUM ('FOOD', 'DRINK', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('BACKOFFICE', 'RESTAURANT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER');

-- CreateTable
CREATE TABLE "Address" (
    "id" UUID NOT NULL,
    "title" VARCHAR NOT NULL,
    "address" VARCHAR NOT NULL,
    "street" VARCHAR,
    "city" VARCHAR,
    "longitude" DOUBLE PRECISION NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "customer_id" UUID,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" VARCHAR,
    "image" VARCHAR,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CounterOtp" (
    "id" UUID NOT NULL,
    "counter" INTEGER NOT NULL,

    CONSTRAINT "CounterOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "phone" VARCHAR NOT NULL,
    "first_name" VARCHAR(255),
    "last_name" VARCHAR(255),
    "birth_day" DATE,
    "email" VARCHAR,
    "image" VARCHAR,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishRestaurant" (
    "id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,

    CONSTRAINT "DishRestaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishSupplement" (
    "id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "supplement_id" UUID NOT NULL,

    CONSTRAINT "DishSupplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dish" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" VARCHAR,
    "price" DOUBLE PRECISION NOT NULL,
    "image" VARCHAR,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "is_new" BOOLEAN NOT NULL DEFAULT false,
    "is_promotion" BOOLEAN NOT NULL DEFAULT false,
    "promotion_price" DOUBLE PRECISION,
    "category_id" UUID NOT NULL,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "customer_id" UUID NOT NULL,
    "order_updates" JSONB NOT NULL,
    "promotions" JSONB NOT NULL,
    "newsletter" JSONB NOT NULL,
    "push_notifications" JSONB NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "icon" VARCHAR NOT NULL,
    "icon_bg_color" VARCHAR NOT NULL,
    "title" VARCHAR NOT NULL,
    "date" DATE NOT NULL,
    "time" VARCHAR NOT NULL,
    "message" VARCHAR NOT NULL,
    "type" "NotificationType" NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "show_chevron" BOOLEAN DEFAULT true,
    "notif_banner" VARCHAR NOT NULL,
    "notif_title" VARCHAR NOT NULL,
    "data" JSONB,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount" DOUBLE PRECISION NOT NULL,
    "order_id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "supplements" JSON,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "type" "OrderType" NOT NULL,
    "address_id" UUID NOT NULL,
    "code_promo" VARCHAR,
    "delivery_fee" DOUBLE PRECISION NOT NULL,
    "tax" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "net_amount" DOUBLE PRECISION NOT NULL,
    "date" DATE,
    "time" TIME(6),
    "fullname" VARCHAR,
    "phone" VARCHAR,
    "email" VARCHAR,
    "note" VARCHAR,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpToken" (
    "id" UUID NOT NULL,
    "code" VARCHAR(255) NOT NULL,
    "phone" VARCHAR NOT NULL,
    "counter" INTEGER,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "OtpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paiement" (
    "id" UUID NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "order_id" UUID NOT NULL,
    "mode" "PaiementMode" NOT NULL,
    "mobile_money_type" "PaiementMobileMoneyType",
    "status" "PaiementStatus" NOT NULL,
    "reference" VARCHAR NOT NULL,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restaurant" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "manager" UUID NOT NULL,
    "description" VARCHAR,
    "image" VARCHAR,
    "address" VARCHAR,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" VARCHAR,
    "email" VARCHAR,
    "schedule" JSON,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialOfferDish" (
    "id" UUID NOT NULL,
    "dish_id" UUID NOT NULL,
    "special_offer_id" UUID NOT NULL,

    CONSTRAINT "SpecialOfferDish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialOffer" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" VARCHAR,
    "image" VARCHAR NOT NULL,
    "tax" DOUBLE PRECISION NOT NULL,
    "start_date" TIMESTAMP(6) NOT NULL,
    "end_date" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "SpecialOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplement" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "image" VARCHAR,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "category" "SupplementCategory" NOT NULL,

    CONSTRAINT "Supplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "fullname" VARCHAR NOT NULL,
    "email" VARCHAR NOT NULL,
    "phone" VARCHAR,
    "password" VARCHAR NOT NULL,
    "image" VARCHAR,
    "address" VARCHAR,
    "password_is_updated" BOOLEAN NOT NULL DEFAULT false,
    "type" "UserType" NOT NULL,
    "role" "UserRole" NOT NULL,
    "restaurant_id" UUID,
    "entity_status" "EntityStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Dish_category_id_available_idx" ON "Dish"("category_id", "available");

-- CreateIndex
CREATE INDEX "Notification_user_id_idx" ON "Notification"("user_id");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE INDEX "Order_address_id_idx" ON "Order"("address_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_type_idx" ON "User"("email", "type");

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRestaurant" ADD CONSTRAINT "DishRestaurant_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRestaurant" ADD CONSTRAINT "DishRestaurant_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishSupplement" ADD CONSTRAINT "DishSupplement_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishSupplement" ADD CONSTRAINT "DishSupplement_supplement_id_fkey" FOREIGN KEY ("supplement_id") REFERENCES "Supplement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dish" ADD CONSTRAINT "Dish_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "Address"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialOfferDish" ADD CONSTRAINT "SpecialOfferDish_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "Dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialOfferDish" ADD CONSTRAINT "SpecialOfferDish_special_offer_id_fkey" FOREIGN KEY ("special_offer_id") REFERENCES "SpecialOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
