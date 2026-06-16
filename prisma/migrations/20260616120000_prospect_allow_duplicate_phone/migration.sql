-- Le module Acquisition (Prospect) enregistre des COMMANDES, pas des clients
-- uniques : un même client (téléphone) doit pouvoir être saisi plusieurs fois
-- (une fois par commande Glovo/Yango, distinguée par `order_number`).
--
-- Une contrainte UNIQUE résiduelle sur `phone` (drift Neon : présente en base
-- mais absente du schema.prisma) bloquait la re-saisie d'un même client avec
-- l'erreur « existe déjà » (P2002). On la supprime ici de façon IDEMPOTENTE :
-- on retire tout index UNIQUE de `Prospect` qui porte sur `phone` SANS inclure
-- `order_number` (on préserve une éventuelle dédup légitime par commande).
--
-- Aucun effet si la contrainte n'existe pas (cas d'une base déjà propre).

DO $$
DECLARE
  idx_name text;
BEGIN
  FOR idx_name IN
    SELECT i.relname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    WHERE t.relname = 'Prospect'
      AND x.indisunique
      AND NOT x.indisprimary
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = ANY (x.indkey)
          AND a.attname = 'phone'
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = ANY (x.indkey)
          AND a.attname = 'order_number'
      )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx_name);
    RAISE NOTICE 'Prospect: contrainte unique sur phone supprimée (%).', idx_name;
  END LOOP;
END $$;

-- Index simple (non unique) pour garder les lookups par téléphone rapides.
CREATE INDEX IF NOT EXISTS "Prospect_phone_idx" ON "Prospect" ("phone");
