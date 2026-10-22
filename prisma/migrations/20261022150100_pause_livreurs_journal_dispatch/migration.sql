-- Pause des livreurs et journal de la diffusion des offres (demande du 22/10 :
-- un livreur en pause ne doit recevoir aucune course).
--
-- Additive et rejouable : trois colonnes facultatives sur "Deliverer" et une
-- table neuve, sans clé étrangère (une ligne du journal doit survivre à la
-- suppression de sa course, et son écriture ne doit jamais faire échouer
-- l'action métier). Aucune reprise de données.

-- Dernier signe de vie (position ou requête authentifiée), au plus un par minute.
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "dernier_signal_at" TIMESTAMP(6);
-- Protocole de l'appli lu dans l'en-tête « x-deli-protocole » : 1 ancienne, 2 nouvelle.
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "protocole_appli" INTEGER;
-- Dernier rappel « Tu es en pause » : au plus un toutes les 30 minutes.
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "rappel_pause_at" TIMESTAMP(6);

CREATE TABLE IF NOT EXISTS "DispatchEvenement" (
    "id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "motif" VARCHAR(60),
    "source" VARCHAR(20),
    "restaurant_id" UUID,
    "course_id" UUID,
    "deliverer_id" UUID,
    "order_id" UUID,
    "offre_id" UUID,
    "details" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchEvenement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DispatchEvenement_created_at_idx" ON "DispatchEvenement"("created_at");
CREATE INDEX IF NOT EXISTS "DispatchEvenement_type_created_at_idx" ON "DispatchEvenement"("type", "created_at");
CREATE INDEX IF NOT EXISTS "DispatchEvenement_deliverer_id_created_at_idx" ON "DispatchEvenement"("deliverer_id", "created_at");
CREATE INDEX IF NOT EXISTS "DispatchEvenement_restaurant_id_created_at_idx" ON "DispatchEvenement"("restaurant_id", "created_at");
CREATE INDEX IF NOT EXISTS "DispatchEvenement_course_id_idx" ON "DispatchEvenement"("course_id");
