-- Incidents sur commande (11/11) : pont entre le CRM, les tickets et les avis.
--
-- Trois tables neuves (catégories, incidents, journal), sept types neufs.
-- Aucune colonne existante n'est touchée : les relations ajoutées aux modèles
-- Order, Restaurant, Customer, User, TicketThread, AvisPrive, Comment et
-- Voucher n'existent que côté Prisma.
--
-- Rejouable : types créés sous garde, tables et index IF NOT EXISTS, clés
-- étrangères sous garde, catégories de départ posées une seule fois. Noms
-- d'index et de contraintes identiques à ceux que Prisma attend (script tiré
-- de `prisma migrate diff`), donc aucune dérive.

DO $$ BEGIN CREATE TYPE "IncidentStatut" AS ENUM ('OUVERT', 'EN_COURS', 'RESOLU', 'CLOTURE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentGravite" AS ENUM ('FAIBLE', 'MOYENNE', 'HAUTE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentOrigine" AS ENUM ('APPEL', 'WHATSAPP', 'SUR_PLACE', 'CONSTAT_INTERNE', 'TICKET', 'AVIS', 'NOTE', 'RAPPEL'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentPole" AS ENUM ('RESTAURANT', 'LIVRAISON', 'CALL_CENTER'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentGeste" AS ENUM ('AUCUN', 'EXCUSES', 'BON', 'REMPLACEMENT', 'REMBOURSEMENT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentRecontact" AS ENUM ('INFORME', 'INJOIGNABLE', 'SANS_RECONTACT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "IncidentSuiviType" AS ENUM ('CREATION', 'ASSIGNATION', 'RESOLUTION', 'BON', 'MESSAGE', 'CLOTURE', 'REOUVERTURE', 'NOTE', 'RETARD'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "IncidentCategorie" (
    "id" UUID NOT NULL,
    "nom" VARCHAR(80) NOT NULL,
    "pole" "IncidentPole" NOT NULL,
    "delai_heures" INTEGER NOT NULL DEFAULT 24,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "ordre" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentCategorie_pkey" PRIMARY KEY ("id")
);


CREATE TABLE IF NOT EXISTS "Incident" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "statut" "IncidentStatut" NOT NULL DEFAULT 'OUVERT',
    "gravite" "IncidentGravite" NOT NULL,
    "origine" "IncidentOrigine" NOT NULL,
    "categorie_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "ticket_id" UUID,
    "avis_id" UUID,
    "comment_id" UUID,
    "pole" "IncidentPole" NOT NULL,
    "agent_id" UUID,
    "assigne_at" TIMESTAMP(6),
    "echeance_at" TIMESTAMP(6) NOT NULL,
    "alerte_retard_at" TIMESTAMP(6),
    "cause" TEXT,
    "action" TEXT,
    "geste" "IncidentGeste",
    "bon_montant" INTEGER,
    "voucher_id" UUID,
    "bon_demande_at" TIMESTAMP(6),
    "bon_message_at" TIMESTAMP(6),
    "bon_message_canal" VARCHAR(20),
    "resolu_at" TIMESTAMP(6),
    "resolu_par_id" UUID,
    "resolu_par_nom" VARCHAR(255),
    "recontact" "IncidentRecontact",
    "reaction" TEXT,
    "cloture_at" TIMESTAMP(6),
    "cloture_par_id" UUID,
    "cloture_par_nom" VARCHAR(255),
    "signale_par_id" UUID,
    "signale_par_nom" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);


CREATE TABLE IF NOT EXISTS "IncidentSuivi" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "type" "IncidentSuiviType" NOT NULL,
    "note" TEXT,
    "statut_avant" "IncidentStatut",
    "statut_apres" "IncidentStatut",
    "auteur_id" UUID,
    "auteur_nom" VARCHAR(255),
    "meta" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentSuivi_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IncidentCategorie_nom_key" ON "IncidentCategorie"("nom");
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_code_key" ON "Incident"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_comment_id_key" ON "Incident"("comment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_voucher_id_key" ON "Incident"("voucher_id");
CREATE INDEX IF NOT EXISTS "Incident_statut_created_at_idx" ON "Incident"("statut", "created_at");
CREATE INDEX IF NOT EXISTS "Incident_restaurant_id_statut_idx" ON "Incident"("restaurant_id", "statut");
CREATE INDEX IF NOT EXISTS "Incident_statut_echeance_at_idx" ON "Incident"("statut", "echeance_at");
CREATE INDEX IF NOT EXISTS "Incident_created_at_idx" ON "Incident"("created_at");
CREATE INDEX IF NOT EXISTS "Incident_order_id_idx" ON "Incident"("order_id");
CREATE INDEX IF NOT EXISTS "Incident_customer_id_idx" ON "Incident"("customer_id");
CREATE INDEX IF NOT EXISTS "Incident_categorie_id_idx" ON "Incident"("categorie_id");
CREATE INDEX IF NOT EXISTS "Incident_ticket_id_idx" ON "Incident"("ticket_id");
CREATE INDEX IF NOT EXISTS "Incident_avis_id_idx" ON "Incident"("avis_id");
CREATE INDEX IF NOT EXISTS "IncidentSuivi_incident_id_created_at_idx" ON "IncidentSuivi"("incident_id", "created_at");
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_categorie_id_fkey" FOREIGN KEY ("categorie_id") REFERENCES "IncidentCategorie"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "TicketThread"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_avis_id_fkey" FOREIGN KEY ("avis_id") REFERENCES "AvisPrive"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Incident" ADD CONSTRAINT "Incident_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "IncidentSuivi" ADD CONSTRAINT "IncidentSuivi_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Un seul incident non clôturé par commande et par catégorie. Index PARTIEL,
-- que Prisma ne sait pas décrire : il n'existe que par cette migration (comme
-- l'index « une fiche sans compte par numéro » du CRM). Deux signalements
-- lancés ensemble : le second reçoit P2002, rendu en 409 par le service.
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_commande_categorie_ouvert_key"
  ON "Incident"("order_id", "categorie_id") WHERE "statut" <> 'CLOTURE';

-- Catégories de départ (maquette du call center). Posées seulement si la
-- table est vide : rejouer la migration ne ramène pas une catégorie renommée.
INSERT INTO "IncidentCategorie" ("id", "nom", "pole", "delai_heures", "ordre")
SELECT gen_random_uuid(), c.nom, c.pole::"IncidentPole", c.delai, c.ordre
FROM (VALUES
  ('Livraison tardive', 'LIVRAISON', 24, 1),
  ('Qualité du plat', 'RESTAURANT', 24, 2),
  ('Commande incomplète', 'RESTAURANT', 24, 3),
  ('Erreur de commande', 'RESTAURANT', 24, 4),
  ('Comportement du livreur', 'LIVRAISON', 48, 5),
  ('Paiement', 'CALL_CENTER', 24, 6),
  ('Accueil call center', 'CALL_CENTER', 48, 7),
  ('Autre', 'CALL_CENTER', 72, 8)
) AS c(nom, pole, delai, ordre)
WHERE NOT EXISTS (SELECT 1 FROM "IncidentCategorie");
