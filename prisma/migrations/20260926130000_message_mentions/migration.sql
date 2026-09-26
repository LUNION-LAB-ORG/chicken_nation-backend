-- MENTIONS d'un collègue dans un message (« @Awa Koné »).
--
-- Le texte « @Prénom Nom » reste en clair dans "Message"."body", pour que la
-- caisse, les courriels et les aperçus restent lisibles. Cette table porte
-- l'identifiant de la personne, seul à faire foi pour le surlignage et la
-- notification, et un libellé figé par le SERVEUR au moment de l'envoi.
--
-- Une table plutôt qu'un tableau : intégrité (clé étrangère), et possibilité de
-- retrouver « mes mentions » par l'index (userId, createdAt).
--
-- ON DELETE CASCADE : la mention disparaît avec son message ou avec le compte.
--
-- `IF NOT EXISTS` partout : l'entrypoint applique les migrations avec `set -e`,
-- un échec tuerait le démarrage. La garde rend le rejeu inoffensif.
-- Noms alignés sur ceux que Prisma produit, pour qu'aucune dérive n'apparaisse.

CREATE TABLE IF NOT EXISTS "MessageMention" (
  "id"        UUID         NOT NULL,
  "messageId" UUID         NOT NULL,
  "userId"    UUID         NOT NULL,
  "libelle"   VARCHAR(160) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("id")
);

-- Une personne n'est mentionnée qu'une fois par message.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageMention_messageId_userId_key"
  ON "MessageMention" ("messageId", "userId");
CREATE INDEX IF NOT EXISTS "MessageMention_userId_createdAt_idx"
  ON "MessageMention" ("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageMention_messageId_fkey') THEN
    ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageMention_userId_fkey') THEN
    ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
