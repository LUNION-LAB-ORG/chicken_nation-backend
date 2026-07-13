-- Cadeau (GIFT) « à utiliser » : un GIFT gratté n'est plus terminal — il reste
-- disponible jusqu'à expiration, puis passe à CONSUMED quand il est ajouté à une
-- commande et facturé à 0 fr (order_id + consumed_at renseignés).
--
-- Additif + idempotent (Neon / double-backend, cf. conventions migrations).

-- Nouvelle valeur d'enum. On ne fait que l'AJOUTER ici (jamais l'utiliser dans la
-- même transaction) → compatible PG12+.
ALTER TYPE "RewardStatus" ADD VALUE IF NOT EXISTS 'CONSUMED';

-- Horodatage de consommation d'un GIFT (NULL tant que non utilisé).
ALTER TABLE "Reward" ADD COLUMN IF NOT EXISTS "consumed_at" TIMESTAMP(6);
