-- Rattache le client visé à l'accusé d'envoi, ce qui matérialise l'audience
-- d'une campagne.
--
-- Migration écrite à la main (dérive `db push` sur les tables de campagnes).
-- Purement additive, colonne nullable.
--
-- Pas de clé étrangère volontairement : un jeton peut être orphelin, et la
-- suppression d'un client ne doit pas emporter l'historique de mesure d'une
-- campagne déjà partie.
ALTER TABLE "PushCampaignTicket" ADD COLUMN "customer_id" UUID;

CREATE INDEX "PushCampaignTicket_customer_id_idx"
  ON "PushCampaignTicket"("customer_id");
