-- GROUPE interne : un drapeau explicite, décidé à la création.
--
-- Il était déduit du nombre de participants, ce qui est faux dès qu'on gère la
-- composition : retirer quelqu'un d'un groupe de trois le faisait cesser d'être
-- un groupe, l'écran de gestion disparaissait, et plus personne ne pouvait l'y
-- remettre. Le même défaut ouvrait une brèche en sens inverse : rien ne
-- distinguait un tête-à-tête d'un groupe, donc rien n'empêchait d'ajouter un
-- tiers à une conversation privée, qui héritait de tout son historique.
--
-- `IF NOT EXISTS` : l'entrypoint applique les migrations avec `set -e`, un échec
-- tuerait le démarrage. La garde rend le rejeu inoffensif.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- REPRISE DE L'EXISTANT : les conversations internes comptant plus de deux
-- participants sont des groupes, c'était la règle jusqu'ici. Les tête-à-tête et
-- les conversations client restent à `false`.
UPDATE "Conversation" c
SET "isGroup" = true
WHERE c."customerId" IS NULL
  AND (SELECT COUNT(*) FROM "ConversationUser" cu WHERE cu."conversationId" = c."id") > 2;
