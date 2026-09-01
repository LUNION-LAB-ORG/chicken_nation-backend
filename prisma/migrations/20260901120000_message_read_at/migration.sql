-- Horodatage de lecture d'un message.
--
-- Migration ECRITE A LA MAIN volontairement. Les tables de campagnes push de ce
-- schéma ont été créées par `prisma db push` et n'ont jamais eu de migration :
-- un `prisma migrate dev` regénérerait leur création et casserait le démarrage,
-- l'entrypoint appliquant les migrations au boot.
--
-- Colonne nullable et sans valeur par défaut : purement additive, les lignes
-- existantes restent valides et aucun compteur n'est touché.
ALTER TABLE "Message" ADD COLUMN "readAt" TIMESTAMP(3);
