-- CRM lot 2 : les clients Glovo/Yango relevés en caisse entrent au CRM, une
-- fiche par numéro de téléphone, avec ou sans compte sur l'application.
--
-- Ce que la migration pose :
--  - une fiche peut exister sans compte : "customer_id" et "registered_at"
--    deviennent facultatifs, la fiche porte le numéro ("phone", "phone_key" =
--    10 derniers chiffres) et le nom relevé à la capture ;
--  - chaque capture ("Prospect") est rattachée à sa fiche ("contact_id") ;
--  - les appels de l'ancienne acquisition repris au CRM gardent le lien vers
--    leur ligne d'origine ("CrmCall"."prospect_call_id"), pour ne jamais être
--    repris deux fois ;
--  - un registre des ventes ("CrmConversion") : une vente par personne et par
--    cycle, une commande ne comptant qu'une fois, même entre deux fiches.
--
-- La reprise des captures, des appels et des coupons de l'ancienne
-- acquisition est faite par le backend (CrmRepriseAcquisitionService), par
-- lots et sous verrou : pas ici, où une erreur bloquerait le démarrage.
--
-- Migration ADDITIVE uniquement : aucune suppression, aucune colonne retirée.
-- Seules lignes existantes modifiées : les fiches du lot 1, qui reçoivent le
-- numéro de leur compte. Les colonnes historiques de "Prospect" restent.
--
-- Tout est rejouable sans effet (IF NOT EXISTS, duplicate_object) :
-- l'entrypoint applique les migrations avec `set -e` et un échec bloque le
-- démarrage du backend.
--
-- ⚠️ Les nouvelles valeurs d'énumération ne sont PAS utilisées dans ce
-- fichier : PostgreSQL refuse d'employer une valeur ajoutée dans la même
-- transaction.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CrmConversionSource" AS ENUM ('CRM', 'ACQUISITION_HISTORIQUE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "CrmChannel" ADD VALUE IF NOT EXISTS 'INCONNU';
ALTER TYPE "CrmEventType" ADD VALUE IF NOT EXISTS 'CAPTURE';
ALTER TYPE "CrmEventType" ADD VALUE IF NOT EXISTS 'INSCRIPTION';

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "contact_id" UUID;

-- AlterTable
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "name" VARCHAR(120),
ADD COLUMN IF NOT EXISTS "phone" VARCHAR(20),
ADD COLUMN IF NOT EXISTS "phone_key" VARCHAR(10),
ALTER COLUMN "customer_id" DROP NOT NULL,
ALTER COLUMN "registered_at" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CrmCall" ADD COLUMN IF NOT EXISTS "prospect_call_id" UUID;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CrmConversion" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "segment" "CrmSegment" NOT NULL,
    "order_id" UUID,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "converted_at" TIMESTAMP(6) NOT NULL,
    "restaurant_id" UUID,
    "capture_id" UUID,
    "campaign_id" UUID,
    "agent_id" UUID,
    "source" "CrmConversionSource" NOT NULL DEFAULT 'CRM',
    "cancelled_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmConversion_pkey" PRIMARY KEY ("id")
);

-- Numéro des fiches du lot 1, repris de leur compte (chiffres seuls).
UPDATE "CrmContact" x
SET "phone" = left(regexp_replace(c."phone", '\D', '', 'g'), 20),
    "phone_key" = right(regexp_replace(c."phone", '\D', '', 'g'), 10)
FROM "Customer" c
WHERE c."id" = x."customer_id"
  AND x."phone_key" IS NULL
  AND c."phone" IS NOT NULL
  AND length(regexp_replace(c."phone", '\D', '', 'g')) >= 6;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmConversion_converted_at_idx" ON "CrmConversion"("converted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmConversion_contact_id_idx" ON "CrmConversion"("contact_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmConversion_segment_converted_at_idx" ON "CrmConversion"("segment", "converted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmConversion_order_id_idx" ON "CrmConversion"("order_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Prospect_contact_id_idx" ON "Prospect"("contact_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmContact_phone_key_idx" ON "CrmContact"("phone_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmCall_prospect_call_id_key" ON "CrmCall"("prospect_call_id");

-- Index uniques PARTIELS, écrits à la main : Prisma ne sait pas les décrire,
-- et un `prisma migrate dev` proposera de les supprimer. Ne pas accepter :
-- ce sont eux qui empêchent les doublons quand deux traitements se croisent
-- (les insertions du backend font ON CONFLICT DO NOTHING sur eux).
--
-- Une seule fiche sans compte par numéro.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_phone_sans_compte_key"
  ON "CrmContact" ("phone_key")
  WHERE "customer_id" IS NULL AND "entity_status" <> 'DELETED';

-- Une commande ne compte qu'une fois dans le registre des ventes.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmConversion_order_active_key"
  ON "CrmConversion" ("order_id")
  WHERE "cancelled_at" IS NULL AND "order_id" IS NOT NULL;

-- Une vente par fiche et par cycle (l'historique d'acquisition n'est pas borné).
CREATE UNIQUE INDEX IF NOT EXISTS "CrmConversion_contact_cycle_active_key"
  ON "CrmConversion" ("contact_id", "cycle")
  WHERE "cancelled_at" IS NULL AND "source" = 'CRM';

-- Clés étrangères, ajoutées séparément et de façon idempotente.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Prospect_contact_id_fkey') THEN
    ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmCall_prospect_call_id_fkey') THEN
    ALTER TABLE "CrmCall" ADD CONSTRAINT "CrmCall_prospect_call_id_fkey" FOREIGN KEY ("prospect_call_id") REFERENCES "ProspectCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmConversion_contact_id_fkey') THEN
    ALTER TABLE "CrmConversion" ADD CONSTRAINT "CrmConversion_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmConversion_restaurant_id_fkey') THEN
    ALTER TABLE "CrmConversion" ADD CONSTRAINT "CrmConversion_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmConversion_capture_id_fkey') THEN
    ALTER TABLE "CrmConversion" ADD CONSTRAINT "CrmConversion_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmConversion_campaign_id_fkey') THEN
    ALTER TABLE "CrmConversion" ADD CONSTRAINT "CrmConversion_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmConversion_agent_id_fkey') THEN
    ALTER TABLE "CrmConversion" ADD CONSTRAINT "CrmConversion_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
