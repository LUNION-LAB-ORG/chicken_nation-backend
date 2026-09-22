-- RÉACTIONS EMOJI sur les messages, comme sur WhatsApp.
--
-- Deux tables plutôt qu'une table polymorphe : les messages de conversation et
-- les messages de ticket sont deux tables distinctes, et une vraie clé
-- étrangère vaut mieux qu'un discriminant qu'aucune contrainte ne vérifie. Le
-- ON DELETE CASCADE fait disparaître les réactions avec leur message.
--
-- L'emoji est stocké en TEXT et non en VARCHAR(n) : un emoji composé (drapeau,
-- teinte de peau, famille assemblée par des liants invisibles) compte plusieurs
-- points de code, et une borne en caractères le couperait au milieu d'une
-- séquence, produisant un symbole inintelligible.
--
-- `IF NOT EXISTS` partout : l'entrypoint applique les migrations avec `set -e`,
-- un échec tuerait le démarrage. La garde rend le rejeu inoffensif.

CREATE TABLE IF NOT EXISTS "MessageReaction" (
  "id"         UUID         NOT NULL,
  "messageId"  UUID         NOT NULL,
  "emoji"      TEXT         NOT NULL,
  "userId"     UUID,
  "customerId" UUID,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TicketMessageReaction" (
  "id"              UUID         NOT NULL,
  "ticketMessageId" UUID         NOT NULL,
  "emoji"           TEXT         NOT NULL,
  "userId"          UUID,
  "customerId"      UUID,
  "delivererId"     UUID,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketMessageReaction_pkey" PRIMARY KEY ("id")
);

-- UNE réaction par personne et par message : c'est la contrainte qui porte la
-- règle, pas le code. Deux clics simultanés ne peuvent pas créer de doublon.
--
-- ⚠️ Les contraintes sont SÉPARÉES par nature d'auteur, et c'est voulu : en
-- PostgreSQL deux NULL ne sont jamais égaux, donc « (message, userId) unique »
-- n'empêche en rien mille clients de réagir au même message, leur userId étant
-- nul. Chaque contrainte ne borne que son propre camp.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageReaction_messageId_userId_key"
  ON "MessageReaction" ("messageId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "MessageReaction_messageId_customerId_key"
  ON "MessageReaction" ("messageId", "customerId");
CREATE INDEX IF NOT EXISTS "MessageReaction_messageId_idx"
  ON "MessageReaction" ("messageId");

CREATE UNIQUE INDEX IF NOT EXISTS "TicketMessageReaction_ticketMessageId_userId_key"
  ON "TicketMessageReaction" ("ticketMessageId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "TicketMessageReaction_ticketMessageId_customerId_key"
  ON "TicketMessageReaction" ("ticketMessageId", "customerId");
CREATE UNIQUE INDEX IF NOT EXISTS "TicketMessageReaction_ticketMessageId_delivererId_key"
  ON "TicketMessageReaction" ("ticketMessageId", "delivererId");
CREATE INDEX IF NOT EXISTS "TicketMessageReaction_ticketMessageId_idx"
  ON "TicketMessageReaction" ("ticketMessageId");

-- Clés étrangères. Ajoutées séparément et de façon idempotente : ADD CONSTRAINT
-- ne connaît pas IF NOT EXISTS en PostgreSQL, on passe donc par un bloc qui
-- interroge le catalogue avant d'écrire.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReaction_messageId_fkey') THEN
    ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReaction_userId_fkey') THEN
    ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageReaction_customerId_fkey') THEN
    ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TicketMessageReaction_ticketMessageId_fkey') THEN
    ALTER TABLE "TicketMessageReaction" ADD CONSTRAINT "TicketMessageReaction_ticketMessageId_fkey"
      FOREIGN KEY ("ticketMessageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TicketMessageReaction_userId_fkey') THEN
    ALTER TABLE "TicketMessageReaction" ADD CONSTRAINT "TicketMessageReaction_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TicketMessageReaction_customerId_fkey') THEN
    ALTER TABLE "TicketMessageReaction" ADD CONSTRAINT "TicketMessageReaction_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TicketMessageReaction_delivererId_fkey') THEN
    ALTER TABLE "TicketMessageReaction" ADD CONSTRAINT "TicketMessageReaction_delivererId_fkey"
      FOREIGN KEY ("delivererId") REFERENCES "Deliverer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
