-- Remboursement KKiaPay depuis l'onglet Paiement d'une commande (12/11).
--
-- Quatre colonnes facultatives sur "Paiement" : la revendication de la demande
-- en cours (un seul clic aboutit, deux backends compris), puis qui a remboursé
-- et quand. Aucune donnée existante n'est modifiée. Rejouable.

ALTER TABLE "Paiement" ADD COLUMN IF NOT EXISTS "remboursement_demande_at" TIMESTAMP(6);
ALTER TABLE "Paiement" ADD COLUMN IF NOT EXISTS "rembourse_at" TIMESTAMP(6);
ALTER TABLE "Paiement" ADD COLUMN IF NOT EXISTS "rembourse_par_id" UUID;
ALTER TABLE "Paiement" ADD COLUMN IF NOT EXISTS "rembourse_par_nom" VARCHAR(255);
