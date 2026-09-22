-- Groupe recevant les ALERTES du système.
--
-- Porté par la conversation plutôt que par un réglage global : le responsable
-- active l'interrupteur dans le groupe qu'il a sous les yeux, au lieu d'aller
-- coller un identifiant de conversation dans un écran de paramètres. Plusieurs
-- groupes peuvent en recevoir, par exemple un canal réseau et un canal dédié.
--
-- `IF NOT EXISTS` : l'entrypoint applique les migrations avec `set -e`, un échec
-- tuerait le démarrage. La garde rend le rejeu inoffensif.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "receivesAlerts" BOOLEAN NOT NULL DEFAULT false;

-- Index partiel : la recherche « quels groupes alerter » se fait à chaque
-- incident, sur une table qui grossit avec chaque conversation client. L'index
-- ne porte que sur les quelques lignes concernées.
CREATE INDEX IF NOT EXISTS "Conversation_receivesAlerts_idx"
  ON "Conversation" ("receivesAlerts") WHERE "receivesAlerts" = true;
