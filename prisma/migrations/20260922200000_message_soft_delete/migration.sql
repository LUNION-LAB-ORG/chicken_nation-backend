-- SUPPRESSION D'UN MESSAGE, en douceur.
--
-- La ligne reste, seul son contenu cesse d'être servi. Un fil de support est
-- une pièce à conviction quand un litige remonte : effacer vraiment la ligne
-- ferait disparaître le fait qu'un message a existé, et avec lui la
-- possibilité de savoir qui a dit quoi. Le client voit un message retiré, la
-- maison garde la trace de ce qu'il contenait et de qui l'a retiré.
--
-- `deletedById` est un simple identifiant, SANS clé étrangère : la trace doit
-- survivre au départ de la personne, comme dans le journal d'audit.
--
-- `IF NOT EXISTS` : l'entrypoint applique les migrations avec `set -e`, un
-- échec tuerait le démarrage. La garde rend le rejeu inoffensif.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deletedById" UUID;

ALTER TABLE "TicketMessage" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "TicketMessage" ADD COLUMN IF NOT EXISTS "deletedById" UUID;
