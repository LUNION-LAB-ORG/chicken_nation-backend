-- Position de lecture de CHAQUE participant d'une conversation.
--
-- `Message.isRead` est un booléen porté par le MESSAGE, pas par le couple
-- (message, lecteur). À deux, cela suffit. Dans un groupe de cinq agents, le
-- premier qui ouvre la conversation éteint la pastille des quatre autres : il
-- est mathématiquement impossible de dire « A a lu, B a lu, C n'a pas lu »
-- avec un seul drapeau.
--
-- On enregistre donc, par participant, la date de sa dernière lecture. Le
-- nombre de non lus devient « les messages postés après ma dernière lecture,
-- que je n'ai pas écrits moi-même ». Retenu plutôt qu'une table de lectures
-- par message, qui aurait grossi en messages × participants pour la même
-- réponse.
--
-- `IF NOT EXISTS` : l'entrypoint du conteneur applique les migrations avec
-- `set -e`, un échec tue donc le démarrage. La garde rend le rejeu inoffensif.
ALTER TABLE "ConversationUser" ADD COLUMN IF NOT EXISTS "lastReadAt" TIMESTAMP(3);

-- REPRISE DE L'EXISTANT, indispensable.
--
-- Une colonne laissée à NULL se lit « jamais ouverte », donc « tout est non
-- lu ». Sans cette reprise, au premier démarrage chaque agent verrait surgir
-- une pastille comptant TOUT l'historique de ses conversations internes, des
-- mois de messages déjà lus, sans aucun moyen de comprendre d'où ça sort. On
-- considère donc l'existant comme lu à l'instant de la migration : c'est le
-- comportement d'aujourd'hui, où les conversations internes ne comptent
-- jamais de non lus. Les messages postés APRÈS compteront normalement.
UPDATE "ConversationUser" SET "lastReadAt" = NOW() WHERE "lastReadAt" IS NULL;
