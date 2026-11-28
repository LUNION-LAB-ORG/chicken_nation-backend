-- Journal d'audit : repères lisibles de la cible (28/11).
--
-- Le journal ne gardait que l'identifiant technique de la cible
-- (« #a4559e28 ») : taper la référence d'une commande dans « Audits » ne
-- ramenait rien. Chaque ligne garde désormais, figés à l'écriture comme le nom
-- de l'auteur :
--   target_ref   : la référence (commande, course, paiement, incident) ;
--   target_name  : la personne concernée (client, livreur, personnel) ;
--   target_phone : son numéro ;
--   search_text  : tout ce qui se cherche, en minuscules et sans accents.
--
-- Additif et rejouable. Aucune clé étrangère : le journal survit à la
-- suppression de ce qu'il décrit.
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "target_ref" VARCHAR;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "target_name" VARCHAR;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "target_phone" VARCHAR;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "search_text" TEXT;

-- LIGNES DÉJÀ ÉCRITES : les mêmes repères, relus sur ce que la ligne désigne
-- (`entity_id`). Sans cela, une commande d'avant la mise en service resterait
-- introuvable par sa référence pendant toute la durée de conservation.
-- Seules les lignes sans repère sont touchées ; rien d'autre n'est modifié.
-- Les retours privés « Ton avis compte » restent sans repère (droit à
-- l'effacement : rien de personnel n'en est copié au journal).

-- Commande.
UPDATE "audit_logs" a
SET "target_ref" = o."reference",
    "target_name" = COALESCE(NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''), NULLIF(btrim(o."fullname"), '')),
    "target_phone" = COALESCE(NULLIF(btrim(c."phone"), ''), NULLIF(btrim(o."phone"), '')),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        o."reference",
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(btrim(o."fullname"), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(coalesce(o."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), ''),
        NULLIF(btrim(o."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Order" o
LEFT JOIN "Customer" c ON c."id" = o."customer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = o."id"::text;

-- Livraison d'une commande (routes /courses/deliveries/:id).
UPDATE "audit_logs" a
SET "target_ref" = o."reference",
    "target_name" = COALESCE(NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''), NULLIF(btrim(o."fullname"), '')),
    "target_phone" = COALESCE(NULLIF(btrim(c."phone"), ''), NULLIF(btrim(o."phone"), '')),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        o."reference",
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(btrim(o."fullname"), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(coalesce(o."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), ''),
        NULLIF(btrim(o."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Delivery" d
JOIN "Order" o ON o."id" = d."order_id"
LEFT JOIN "Customer" c ON c."id" = o."customer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = d."id"::text;

-- Paiement : sa référence, et la commande qu'il règle.
UPDATE "audit_logs" a
SET "target_ref" = COALESCE(o."reference", p."reference"),
    "target_name" = COALESCE(NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''), NULLIF(btrim(o."fullname"), '')),
    "target_phone" = COALESCE(NULLIF(btrim(c."phone"), ''), NULLIF(btrim(o."phone"), '')),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        p."reference",
        o."reference",
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(btrim(o."fullname"), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(coalesce(o."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), ''),
        NULLIF(btrim(o."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Paiement" p
LEFT JOIN "Order" o ON o."id" = p."order_id"
LEFT JOIN "Customer" c ON c."id" = o."customer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = p."id"::text;

-- Incident : son code, la commande et le client.
UPDATE "audit_logs" a
SET "target_ref" = i."code",
    "target_name" = COALESCE(NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''), NULLIF(btrim(o."fullname"), '')),
    "target_phone" = COALESCE(NULLIF(btrim(c."phone"), ''), NULLIF(btrim(o."phone"), '')),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        i."code",
        o."reference",
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(btrim(o."fullname"), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(coalesce(o."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), ''),
        NULLIF(btrim(o."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Incident" i
JOIN "Order" o ON o."id" = i."order_id"
LEFT JOIN "Customer" c ON c."id" = i."customer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = i."id"::text;

-- Client.
UPDATE "audit_logs" a
SET "target_name" = NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
    "target_phone" = NULLIF(btrim(c."phone"), ''),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Customer" c
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = c."id"::text;

-- Fiche du CRM (routes /crm/contacts/:id) : le client suivi.
UPDATE "audit_logs" a
SET "target_name" = COALESCE(NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''), NULLIF(btrim(k."name"), '')),
    "target_phone" = COALESCE(NULLIF(btrim(c."phone"), ''), NULLIF(btrim(k."phone"), '')),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        NULLIF(btrim(concat_ws(' ', c."first_name", c."last_name")), ''),
        NULLIF(btrim(k."name"), ''),
        NULLIF(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(coalesce(k."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(c."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "CrmContact" k
LEFT JOIN "Customer" c ON c."id" = k."customer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = k."id"::text;

-- Livreur.
UPDATE "audit_logs" a
SET "target_ref" = l."reference",
    "target_name" = NULLIF(btrim(concat_ws(' ', l."first_name", l."last_name")), ''),
    "target_phone" = NULLIF(btrim(l."phone"), ''),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        l."reference",
        NULLIF(btrim(concat_ws(' ', l."first_name", l."last_name")), ''),
        NULLIF(regexp_replace(coalesce(l."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(l."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Deliverer" l
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = l."id"::text;

-- Course : sa référence et son livreur.
UPDATE "audit_logs" a
SET "target_ref" = r."reference",
    "target_name" = NULLIF(btrim(concat_ws(' ', l."first_name", l."last_name")), ''),
    "target_phone" = NULLIF(btrim(l."phone"), ''),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        r."reference",
        l."reference",
        NULLIF(btrim(concat_ws(' ', l."first_name", l."last_name")), ''),
        NULLIF(regexp_replace(coalesce(l."phone", ''), '[^0-9]', '', 'g'), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "Course" r
LEFT JOIN "Deliverer" l ON l."id" = r."deliverer_id"
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = r."id"::text;

-- Membre du personnel.
UPDATE "audit_logs" a
SET "target_name" = NULLIF(btrim(u."fullname"), ''),
    "target_phone" = NULLIF(btrim(u."phone"), ''),
    "search_text" = btrim(translate(lower(concat_ws(' ',
        NULLIF(btrim(u."fullname"), ''),
        NULLIF(regexp_replace(coalesce(u."phone", ''), '[^0-9]', '', 'g'), ''),
        NULLIF(btrim(u."email"), '')
    )), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'))
FROM "User" u
WHERE a."search_text" IS NULL
  AND a."target_ref" IS NULL AND a."target_name" IS NULL AND a."target_phone" IS NULL
  AND a."path" NOT LIKE '%/avis-prives%'
  AND a."entity_id" = u."id"::text;
