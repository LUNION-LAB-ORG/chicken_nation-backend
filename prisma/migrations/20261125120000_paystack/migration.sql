-- PAIEMENT EN LIGNE PAR PAYSTACK (25/11). Additive et rejouable : un type,
-- une colonne facultative, une table. Aucune donnée existante modifiée.

DO $$ BEGIN
  CREATE TYPE "FournisseurPaiement" AS ENUM ('KKIAPAY', 'PAYSTACK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Paiement" ADD COLUMN IF NOT EXISTS "fournisseur" "FournisseurPaiement";

CREATE TABLE IF NOT EXISTS "TentativePaiement" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "fournisseur" "FournisseurPaiement" NOT NULL,
  "reference" VARCHAR(100) NOT NULL,
  "montant" INTEGER NOT NULL,
  "frais" INTEGER NOT NULL DEFAULT 0,
  "moyen" VARCHAR(20),
  "restaurant_id" UUID,
  "sous_compte" VARCHAR(100),
  "canal" VARCHAR(20) NOT NULL,
  "statut" VARCHAR(20) NOT NULL DEFAULT 'INITIEE',
  "verifiee_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "TentativePaiement_pkey" PRIMARY KEY ("id")
);

-- Table déjà créée par une première version de cette migration (banc d'essai).
ALTER TABLE "TentativePaiement" ADD COLUMN IF NOT EXISTS "frais" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TentativePaiement" ADD COLUMN IF NOT EXISTS "moyen" VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS "TentativePaiement_reference_key" ON "TentativePaiement"("reference");
CREATE INDEX IF NOT EXISTS "TentativePaiement_order_id_idx" ON "TentativePaiement"("order_id");
CREATE INDEX IF NOT EXISTS "TentativePaiement_statut_created_at_idx" ON "TentativePaiement"("statut", "created_at");

DO $$ BEGIN
  ALTER TABLE "TentativePaiement" ADD CONSTRAINT "TentativePaiement_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
