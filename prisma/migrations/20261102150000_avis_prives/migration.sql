-- Retours privés « Ton avis compte » (02/11), page /fr/avis du site.
--
-- Deux tables neuves (l'avis et son journal de suivi), six types neufs. Aucune
-- colonne existante n'est touchée : les relations ajoutées aux modèles Customer,
-- Restaurant, Order, TicketThread et User n'existent que côté Prisma.
--
-- Rejouable : types créés sous garde, tables et index IF NOT EXISTS, clés
-- étrangères sous garde. Noms d'index et de contraintes identiques à ceux que
-- Prisma attend (vérifié par `prisma migrate diff`), donc aucune dérive.

DO $$ BEGIN CREATE TYPE "AvisRessenti" AS ENUM ('PAS_CONTENT','PEUT_MIEUX_FAIRE','AU_TOP'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvisCanal" AS ENUM ('APPLI','SITE_WEB','TELEPHONE','WHATSAPP','SUR_PLACE','AUTRE_PLATEFORME'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvisStatut" AS ENUM ('NOUVEAU','A_RAPPELER','EN_COURS','INJOIGNABLE','INCIDENT_OUVERT','RESOLU','CLASSE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvisSolution" AS ENUM ('EXCUSES','GESTE_COMMERCIAL','REMPLACEMENT','REMBOURSEMENT','AUCUNE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvisSuiviType" AS ENUM ('SYSTEME','APPEL','WHATSAPP','NOTE','STATUT','COMMANDE','AGENT','INCIDENT','SUPPRESSION'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AvisResultat" AS ENUM ('JOINT','INJOIGNABLE','MESSAGERIE'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "AvisPrive" (
  "id" UUID NOT NULL,
  "ressenti" "AvisRessenti" NOT NULL,
  "canal" "AvisCanal" NOT NULL,
  "restaurant_id" UUID,
  "commentaire" TEXT NOT NULL,
  "telephone" VARCHAR(20),
  "prenom" VARCHAR(60),
  "accord_rappel" BOOLEAN NOT NULL DEFAULT false,
  "source" VARCHAR(40) NOT NULL DEFAULT 'site',
  "customer_id" UUID,
  "rapproche_at" TIMESTAMP(6),
  "order_id" UUID,
  "ticket_id" UUID,
  "ticket_demande_at" TIMESTAMP(6),
  "statut" "AvisStatut" NOT NULL DEFAULT 'NOUVEAU',
  "echeance_at" TIMESTAMP(6),
  "premier_contact_at" TIMESTAMP(6),
  "alerte_retard_at" TIMESTAMP(6),
  "tentatives_appel" INTEGER NOT NULL DEFAULT 0,
  "solution" "AvisSolution",
  "resolu_at" TIMESTAMP(6),
  "clos_at" TIMESTAMP(6),
  "agent_id" UUID,
  "entity_status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
  "supprime_at" TIMESTAMP(6),
  "supprime_par_id" UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AvisPrive_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AvisPrive_ticket_id_key" ON "AvisPrive"("ticket_id");
CREATE INDEX IF NOT EXISTS "AvisPrive_entity_status_created_at_idx" ON "AvisPrive"("entity_status","created_at");
CREATE INDEX IF NOT EXISTS "AvisPrive_entity_status_statut_idx" ON "AvisPrive"("entity_status","statut");
CREATE INDEX IF NOT EXISTS "AvisPrive_restaurant_id_created_at_idx" ON "AvisPrive"("restaurant_id","created_at");
CREATE INDEX IF NOT EXISTS "AvisPrive_statut_echeance_at_idx" ON "AvisPrive"("statut","echeance_at");
CREATE INDEX IF NOT EXISTS "AvisPrive_telephone_idx" ON "AvisPrive"("telephone");
CREATE INDEX IF NOT EXISTS "AvisPrive_customer_id_idx" ON "AvisPrive"("customer_id");
CREATE INDEX IF NOT EXISTS "AvisPrive_agent_id_idx" ON "AvisPrive"("agent_id");
CREATE INDEX IF NOT EXISTS "AvisPrive_order_id_idx" ON "AvisPrive"("order_id");

DO $$ BEGIN ALTER TABLE "AvisPrive" ADD CONSTRAINT "AvisPrive_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "AvisPrive" ADD CONSTRAINT "AvisPrive_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "AvisPrive" ADD CONSTRAINT "AvisPrive_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "AvisPrive" ADD CONSTRAINT "AvisPrive_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "TicketThread"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "AvisPrive" ADD CONSTRAINT "AvisPrive_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "AvisPriveSuivi" (
  "id" UUID NOT NULL,
  "avis_id" UUID NOT NULL,
  "type" "AvisSuiviType" NOT NULL,
  "resultat" "AvisResultat",
  "note" TEXT,
  "statut_avant" "AvisStatut",
  "statut_apres" "AvisStatut",
  "solution" "AvisSolution",
  "auteur_id" UUID,
  "auteur_nom" VARCHAR(255),
  "meta" JSONB,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AvisPriveSuivi_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AvisPriveSuivi_avis_id_created_at_idx" ON "AvisPriveSuivi"("avis_id","created_at");
DO $$ BEGIN ALTER TABLE "AvisPriveSuivi" ADD CONSTRAINT "AvisPriveSuivi_avis_id_fkey" FOREIGN KEY ("avis_id") REFERENCES "AvisPrive"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "AvisPriveSuivi" ADD CONSTRAINT "AvisPriveSuivi_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
