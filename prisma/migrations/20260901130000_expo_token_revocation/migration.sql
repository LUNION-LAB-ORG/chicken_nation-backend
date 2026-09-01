-- Révocation réversible d'un jeton Expo mort.
--
-- Migration écrite à la main (voir 20260901120000_message_read_at pour la
-- raison : dérive `db push` sur les tables de campagnes push).
--
-- Purement additive. Aucune ligne existante n'est touchée, aucun envoi en cours
-- n'est modifié tant que le code ne révoque rien.
ALTER TABLE "NotificationSetting"
  ADD COLUMN "expo_push_token_revoked" VARCHAR,
  ADD COLUMN "expo_push_token_revoked_at" TIMESTAMP(3);

-- Un envoi de campagne balaie les réglages par jeton non nul. L'index manquait.
CREATE INDEX IF NOT EXISTS "NotificationSetting_expo_push_token_idx"
  ON "NotificationSetting"("expo_push_token");
