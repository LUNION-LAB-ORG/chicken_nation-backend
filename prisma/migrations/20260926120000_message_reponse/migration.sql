-- RÉPONDRE À UN MESSAGE PRÉCIS : le message cité.
--
-- Une colonne et non une clé de `meta` : `meta` est réécrit en entier à chaque
-- création et vidé à la suppression, sans jointure ni intégrité possibles. Le
-- texte cité n'est jamais recopié : l'extrait se calcule à la lecture, si bien
-- qu'un original supprimé cesse aussitôt d'apparaître dans les réponses.
--
-- Colonne NULLABLE et sans défaut : l'ajout est instantané, aucune ligne n'est
-- réécrite. L'index et la clé étrangère ne portent que sur des NULL.
--
-- ON DELETE SET NULL : l'effacement réel d'un original (rare, la suppression
-- est douce) laisse la réponse en place, simplement sans citation.
--
-- `IF NOT EXISTS` partout : l'entrypoint applique les migrations avec `set -e`,
-- un échec tuerait le démarrage. La garde rend le rejeu inoffensif.
-- Noms alignés sur ceux que Prisma produit, pour qu'aucune dérive n'apparaisse.

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "replyToId" UUID;

CREATE INDEX IF NOT EXISTS "Message_replyToId_idx" ON "Message" ("replyToId");

-- ADD CONSTRAINT ne connaît pas IF NOT EXISTS en PostgreSQL : on passe par un
-- bloc qui interroge le catalogue avant d'écrire.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_replyToId_fkey') THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey"
      FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
