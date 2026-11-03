-- Parrainage : codes lisibles CN-PRENOM (03/11).
--
-- POURQUOI
-- Le code de parrainage valait `CN` + 6 caractères tirés au hasard (`CNABC23`) :
-- personne ne savait à qui il appartenait. Il porte désormais le prénom du
-- parrain (`CN-AWA`), sinon son nom (`CN-KOUADIO`), sinon le prénom suivi d'un
-- numéro (`CN-AWA2`). Sans nom : `CN-CLIENT` (jamais les chiffres du téléphone,
-- le parrain diffuse son code). Même règle que le serveur (referral-code.rules.ts).
--
-- PÉRIMÈTRE
-- Clients qui ont déjà un code à l'ancien format (sans `CN-`). L'ancien code
-- passe dans `referral_code_ancien` et RESTE VALABLE : un lien ou un message
-- déjà partagé continue de marcher. Le parrain voit son nouveau code à la
-- prochaine ouverture de « Inviter des amis » ; aucun message ne part.
-- Le parrain qui a le plus de filleuls (puis le plus ancien) garde la forme
-- sans numéro quand plusieurs partagent un prénom.
--
-- Rejouable : une fois passée, plus aucun code n'est à l'ancien format.
-- Le parrainage déjà enregistré (`Referral.referral_code`) n'est pas touché :
-- il garde le code utilisé à l'époque.
--
-- MESURE AVANT (lecture seule, dans Neon) :
--   SELECT count(*) AS codes_a_renommer FROM "Customer"
--   WHERE referral_code IS NOT NULL AND referral_code !~ '^CN-';
-- CONTRÔLE APRÈS : la même requête rend 0, et
--   SELECT referral_code, referral_code_ancien, first_name, last_name FROM "Customer"
--   WHERE referral_code_ancien IS NOT NULL ORDER BY referral_code LIMIT 50;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "referral_code_ancien" VARCHAR;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_referral_code_ancien_key" ON "Customer"("referral_code_ancien");

WITH clients AS (
  SELECT c.id,
         c.created_at,
         (SELECT count(*) FROM "Referral" r WHERE r.referrer_id = c.id) AS filleuls,
         left(regexp_replace(upper(translate(split_part(btrim(coalesce(c.first_name, '')), ' ', 1),
              'àáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÙÚÛÜÝŸ',
              'aaaaaaaceeeeiiiinooooooouuuuyyAAAAAAACEEEEIIIINOOOOOOOUUUUYY')), '[^A-Z]', '', 'g'), 12) AS prenom,
         left(regexp_replace(upper(translate(split_part(btrim(coalesce(c.last_name, '')), ' ', 1),
              'àáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÙÚÛÜÝŸ',
              'aaaaaaaceeeeiiiinooooooouuuuyyAAAAAAACEEEEIIIINOOOOOOOUUUUYY')), '[^A-Z]', '', 'g'), 12) AS nom
  FROM "Customer" c
  WHERE c.referral_code IS NOT NULL
    AND c.referral_code !~ '^CN-'
),
bases AS (
  SELECT id, created_at, filleuls,
         CASE WHEN length(prenom) >= 2 THEN prenom
              WHEN length(nom) >= 2 THEN nom
              ELSE 'CLIENT' END AS b1,
         CASE WHEN length(prenom) >= 2 AND length(nom) >= 2 THEN nom END AS b2
  FROM clients
),
pris AS (
  SELECT referral_code AS code FROM "Customer" WHERE referral_code ~ '^CN-'
  UNION
  SELECT code FROM "PromoCode"
),
-- 1. Le prénom seul.
tour1 AS (
  SELECT id, 'CN-' || b1 AS code,
         row_number() OVER (PARTITION BY b1 ORDER BY filleuls DESC, created_at ASC, id) AS rang
  FROM bases
),
gagnants1 AS (
  SELECT id, code FROM tour1
  WHERE rang = 1 AND code NOT IN (SELECT code FROM pris)
),
-- 2. Le nom seul, s'il est libre.
tour2 AS (
  SELECT b.id, 'CN-' || b.b2 AS code,
         row_number() OVER (PARTITION BY b.b2 ORDER BY b.filleuls DESC, b.created_at ASC, b.id) AS rang
  FROM bases b
  WHERE b.b2 IS NOT NULL
    AND b.id NOT IN (SELECT id FROM gagnants1)
    AND 'CN-' || b.b2 NOT IN (SELECT code FROM gagnants1)
    AND 'CN-' || b.b2 NOT IN (SELECT code FROM pris)
),
gagnants2 AS (
  SELECT id, code FROM tour2 WHERE rang = 1
),
-- 3. Le prénom numéroté à partir de 2.
tour3 AS (
  SELECT b.id,
         'CN-' || b.b1 || (1 + row_number() OVER (PARTITION BY b.b1 ORDER BY b.filleuls DESC, b.created_at ASC, b.id))::text AS code
  FROM bases b
  WHERE b.id NOT IN (SELECT id FROM gagnants1)
    AND b.id NOT IN (SELECT id FROM gagnants2)
),
nouveaux AS (
  SELECT id, code FROM gagnants1
  UNION ALL SELECT id, code FROM gagnants2
  UNION ALL SELECT id, code FROM tour3
)
UPDATE "Customer" c
SET referral_code_ancien = c.referral_code,
    referral_code = n.code
FROM nouveaux n
WHERE n.id = c.id;
