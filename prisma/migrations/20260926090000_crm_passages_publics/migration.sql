-- CRM lot 3 : historique des passages et campagnes sur tous les publics.
--
-- 1. Passages (« CrmCycle ») : une ligne par passage d'une fiche dans un
--    public (inscrit sans commande, client inactif, client Glovo/Yango). Un
--    client converti qui décroche repart pour un nouveau cycle : la fiche est
--    remise à zéro, pas son passage précédent. Sans cet historique, un chiffre
--    par public sur une période passée serait faux : le client quitterait après
--    coup la cohorte où il était entré.
--    Les passages sont écrits par un DÉCLENCHEUR PostgreSQL sur "CrmContact",
--    seul point d'écriture (une dizaine de chemins changent le cycle ou le
--    public, souvent en SQL par lots). ⚠️ Invisible pour Prisma : ne jamais
--    recréer la base par `db push`, toujours appliquer les migrations.
-- 2. Cycle sur les appels et les coupons, public et cycle sur les membres de
--    campagne : chaque action est rattachée au passage où elle a eu lieu.
--    Un second déclencheur remplit le cycle d'un appel ou d'un coupon inséré
--    sans lui (filet de sécurité pour le SQL brut).
-- 3. Publics d'une campagne (« CrmCampaignPublic ») : critères, offre et
--    objectifs propres à chaque public visé, Glovo et Yango compris.
--
-- Migration ADDITIVE : aucune suppression. "ConversionCampaign".segments,
-- registered_from et registered_to restent, recopiés pour la compatibilité.
-- Rejouable sans effet (IF NOT EXISTS, ON CONFLICT, WHERE ... IS NULL).
-- Aucune nouvelle valeur d'énumération.

-- ---------------------------------------------------------------------------
-- Passages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CrmCycle" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contact_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "segment" "CrmSegment" NOT NULL,
    "segment_since" TIMESTAMP(6) NOT NULL,
    "crm_entered_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(6),
    "close_reason" VARCHAR(20),
    "already_customer" BOOLEAN,
    "rebuilt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CrmCycle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CrmCycle_contact_id_cycle_key" ON "CrmCycle"("contact_id", "cycle");
CREATE INDEX IF NOT EXISTS "CrmCycle_segment_crm_entered_at_idx" ON "CrmCycle"("segment", "crm_entered_at");
CREATE INDEX IF NOT EXISTS "CrmCycle_segment_segment_since_idx" ON "CrmCycle"("segment", "segment_since");

-- ---------------------------------------------------------------------------
-- Colonnes
-- ---------------------------------------------------------------------------
ALTER TABLE "CrmCall" ADD COLUMN IF NOT EXISTS "cycle" INTEGER,
ADD COLUMN IF NOT EXISTS "imported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CrmCoupon" ADD COLUMN IF NOT EXISTS "cycle" INTEGER;
ALTER TABLE "CrmCampaignMember" ADD COLUMN IF NOT EXISTS "segment" "CrmSegment",
ADD COLUMN IF NOT EXISTS "cycle" INTEGER;

CREATE TABLE IF NOT EXISTS "CrmCampaignPublic" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "segment" "CrmSegment" NOT NULL,
    "period_from" DATE,
    "period_to" DATE,
    "restaurant_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "account" VARCHAR(10),
    "relapsed_only" BOOLEAN NOT NULL DEFAULT false,
    "offer_id" UUID,
    "target_conversion_rate" DOUBLE PRECISION,
    "target_contacts_count" INTEGER,
    "targeted_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CrmCampaignPublic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CrmCampaignPublic_campaign_id_segment_key" ON "CrmCampaignPublic"("campaign_id", "segment");

CREATE INDEX IF NOT EXISTS "CrmCall_contact_id_cycle_idx" ON "CrmCall"("contact_id", "cycle");
CREATE INDEX IF NOT EXISTS "CrmCoupon_contact_id_cycle_idx" ON "CrmCoupon"("contact_id", "cycle");
CREATE INDEX IF NOT EXISTS "CrmConversion_contact_id_cycle_idx" ON "CrmConversion"("contact_id", "cycle");
CREATE INDEX IF NOT EXISTS "CrmCampaignMember_campaign_id_segment_idx" ON "CrmCampaignMember"("campaign_id", "segment");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmCycle_contact_id_fkey') THEN
    ALTER TABLE "CrmCycle" ADD CONSTRAINT "CrmCycle_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmCampaignPublic_campaign_id_fkey') THEN
    ALTER TABLE "CrmCampaignPublic" ADD CONSTRAINT "CrmCampaignPublic_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ConversionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrmCampaignPublic_offer_id_fkey') THEN
    ALTER TABLE "CrmCampaignPublic" ADD CONSTRAINT "CrmCampaignPublic_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "CrmOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Reprise de l'existant (rien en production au moment du lot 3 : les lots 1,
-- 2 et 3 partent ensemble ; ces étapes servent aux bases déjà ouvertes).
-- ---------------------------------------------------------------------------

-- Passage en cours de chaque fiche. L'entrée réelle au CRM est la création de
-- la fiche pour un premier passage, sinon la dernière entrée du journal.
INSERT INTO "CrmCycle" ("contact_id", "cycle", "segment", "segment_since", "crm_entered_at", "rebuilt")
SELECT x."id", x."cycle", x."segment", x."segment_since",
       CASE WHEN x."cycle" = 1 THEN x."created_at"
            ELSE coalesce((SELECT max(e."created_at") FROM "CrmEvent" e WHERE e."contact_id" = x."id" AND e."type" = 'ENTREE'), x."updated_at") END,
       x."cycle" > 1
FROM "CrmContact" x
ON CONFLICT ("contact_id", "cycle") DO NOTHING;

-- Passages déjà clos, reconstitués d'après le registre des ventes.
INSERT INTO "CrmCycle" ("contact_id", "cycle", "segment", "segment_since", "crm_entered_at", "closed_at", "close_reason", "rebuilt")
SELECT DISTINCT ON (v."contact_id", v."cycle") v."contact_id", v."cycle", v."segment", v."converted_at", v."converted_at",
       v."converted_at", 'RECHUTE', true
FROM "CrmConversion" v JOIN "CrmContact" x ON x."id" = v."contact_id"
WHERE v."cycle" < x."cycle"
ORDER BY v."contact_id", v."cycle", v."converted_at"
ON CONFLICT ("contact_id", "cycle") DO NOTHING;

-- Cycle des appels et des coupons : le passage en cours au moment de l'action,
-- 0 pour l'historique antérieur au premier passage (ex. un appel de rétention
-- ancien chez un client devenu inactif depuis).
UPDATE "CrmCall" k SET "cycle" = coalesce((
  SELECT max(y."cycle") FROM "CrmCycle" y WHERE y."contact_id" = k."contact_id" AND y."segment_since" <= k."created_at"), 0)
WHERE k."cycle" IS NULL;
UPDATE "CrmCoupon" c SET "cycle" = coalesce((
  SELECT max(y."cycle") FROM "CrmCycle" y WHERE y."contact_id" = c."contact_id" AND y."segment_since" <= c."sent_at"), 0)
WHERE c."cycle" IS NULL;

-- Appels repris des anciens écrans (acquisition, rétention) : exclus des
-- mesures d'effort et de premier appel, gardés dans la fiche et les verbatims.
UPDATE "CrmCall" SET "imported" = true
WHERE "imported" = false AND "call_status_id" IS NULL
  AND ("status_label" LIKE '% (acquisition)' OR "status_label" LIKE '% (rétention)');

-- Public et cycle des membres de campagne : ceux du passage à leur entrée.
UPDATE "CrmCampaignMember" m
SET "segment" = coalesce((SELECT y."segment" FROM "CrmCycle" y WHERE y."contact_id" = m."contact_id" AND y."crm_entered_at" <= m."joined_at"
                          ORDER BY y."cycle" DESC LIMIT 1), x."segment"),
    "cycle" = coalesce((SELECT y."cycle" FROM "CrmCycle" y WHERE y."contact_id" = m."contact_id" AND y."crm_entered_at" <= m."joined_at"
                        ORDER BY y."cycle" DESC LIMIT 1), x."cycle")
FROM "CrmContact" x
WHERE x."id" = m."contact_id" AND (m."segment" IS NULL OR m."cycle" IS NULL);

-- Publics des campagnes existantes. La période d'inscription ne vaut que pour
-- les inscrits sans commande.
INSERT INTO "CrmCampaignPublic" ("campaign_id", "segment", "period_from", "period_to", "targeted_count")
SELECT c."id", s.segment,
       CASE WHEN s.segment = 'JAMAIS_COMMANDE' THEN c."registered_from"::date END,
       CASE WHEN s.segment = 'JAMAIS_COMMANDE' THEN c."registered_to"::date END,
       (SELECT count(*) FROM "CrmCampaignMember" m WHERE m."campaign_id" = c."id" AND m."segment" = s.segment)::int
FROM "ConversionCampaign" c
CROSS JOIN LATERAL unnest(coalesce(c."segments", ARRAY['JAMAIS_COMMANDE']::"CrmSegment"[])) AS s(segment)
ON CONFLICT ("campaign_id", "segment") DO NOTHING;

ALTER TABLE "CrmCall" ALTER COLUMN "cycle" SET NOT NULL;
ALTER TABLE "CrmCoupon" ALTER COLUMN "cycle" SET NOT NULL;
ALTER TABLE "CrmCampaignMember" ALTER COLUMN "segment" SET NOT NULL,
ALTER COLUMN "cycle" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Déclencheurs (après la reprise : ils ne rejouent rien de ce qui précède)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_suivre_passage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."cycle" <> OLD."cycle" THEN
    IF TG_OP = 'UPDATE' THEN
      UPDATE "CrmCycle" SET "closed_at" = now(),
             "close_reason" = CASE WHEN NEW."segment" IN ('GLOVO', 'YANGO') THEN 'NOUVELLE_CAPTURE' ELSE 'RECHUTE' END
      WHERE "contact_id" = NEW."id" AND "cycle" < NEW."cycle" AND "closed_at" IS NULL;
    END IF;
    INSERT INTO "CrmCycle" ("contact_id", "cycle", "segment", "segment_since", "crm_entered_at")
    VALUES (NEW."id", NEW."cycle", NEW."segment", NEW."segment_since", now())
    ON CONFLICT ("contact_id", "cycle") DO NOTHING;
  ELSIF NEW."segment" IS DISTINCT FROM OLD."segment" OR NEW."segment_since" IS DISTINCT FROM OLD."segment_since" THEN
    -- Requalification d'une fiche jamais travaillée (reprise), dans le même cycle.
    -- « Déjà client » se recalcule (réconciliation) sur le nouveau public et la nouvelle date.
    UPDATE "CrmCycle" SET "segment" = NEW."segment", "segment_since" = NEW."segment_since", "already_customer" = NULL
    WHERE "contact_id" = NEW."id" AND "cycle" = NEW."cycle";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "CrmContact_passage" ON "CrmContact";
CREATE TRIGGER "CrmContact_passage" AFTER INSERT OR UPDATE OF "cycle", "segment", "segment_since"
  ON "CrmContact" FOR EACH ROW EXECUTE FUNCTION crm_suivre_passage();

-- Filet de sécurité : un appel ou un coupon inséré sans cycle prend celui du
-- passage en cours de sa fiche. Le code l'écrit toujours explicitement.
CREATE OR REPLACE FUNCTION crm_cycle_par_defaut() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cycle" IS NULL THEN
    SELECT x."cycle" INTO NEW."cycle" FROM "CrmContact" x WHERE x."id" = NEW."contact_id";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "CrmCall_cycle" ON "CrmCall";
CREATE TRIGGER "CrmCall_cycle" BEFORE INSERT ON "CrmCall" FOR EACH ROW EXECUTE FUNCTION crm_cycle_par_defaut();
DROP TRIGGER IF EXISTS "CrmCoupon_cycle" ON "CrmCoupon";
CREATE TRIGGER "CrmCoupon_cycle" BEFORE INSERT ON "CrmCoupon" FOR EACH ROW EXECUTE FUNCTION crm_cycle_par_defaut();
