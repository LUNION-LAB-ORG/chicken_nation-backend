-- Image jointe à une diffusion.
--
-- ⚠️ Migration SÉPARÉE, et non un ajout dans `20260826150000_diffusion_messages`.
-- Cette dernière est déjà appliquée en production : Prisma garde une somme de
-- contrôle de chaque migration jouée et refuse de repartir si le fichier a
-- changé depuis. Modifier une migration appliquée bloque le déploiement.
--
-- La clé S3 est recopiée dans `Message.meta.imageUrl` à la livraison, exactement
-- comme une image de conversation ordinaire : l'application sait déjà l'afficher.
ALTER TABLE "MessageBroadcast" ADD COLUMN "image_url" VARCHAR;
