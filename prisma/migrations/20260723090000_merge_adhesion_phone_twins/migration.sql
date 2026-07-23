-- FUSION des comptes clients dupliqués par le format de téléphone.
--
-- Le tunnel d'adhésion du site stockait `225XXXXXXXXXX` (sans `+`) alors que le
-- login OTP de l'app écrit `+225XXXXXXXXXX`. Le match EXACT du login ne
-- retrouvait donc pas les comptes pré-inscrits via le site → un DOUBLON vide
-- était créé au login : formulaire d'inscription re-affiché, demande de carte
-- (faite sur le site) invisible dans l'app, validations backoffice sans effet
-- apparent pour le client.
--
-- Terminologie : d = doublon `225…` (créé par l'adhésion), t = twin `+225…`
-- (compte app). On transfère les artefacts carte du doublon vers le twin, on
-- complète l'identité manquante du twin, puis on soft-delete le doublon. Les
-- `225…` SANS twin sont simplement normalisés en `+225…`.
--
-- Idempotent : rejouable sans effet (les doublons fusionnés restent DELETED et
-- leurs artefacts déjà transférés ne re-matchent pas).

-- 1) Demandes de carte CLOSES du doublon → twin (aucun risque : l'index unique
--    partiel card_request_one_open_per_customer ne couvre que PENDING/IN_REVIEW).
UPDATE "CardRequest" cr
SET customer_id = t.id
FROM "Customer" d
JOIN "Customer" t ON t.phone = '+' || d.phone AND t.id <> d.id
WHERE cr.customer_id = d.id
  AND d.phone ~ '^225[0-9]{10}$'
  AND cr.status IN ('APPROVED', 'REJECTED', 'EXPIRED');

-- 2) Demande OUVERTE du doublon → twin, seulement si le twin n'en a pas déjà
--    une ouverte (sinon violation de l'index partiel).
UPDATE "CardRequest" cr
SET customer_id = t.id
FROM "Customer" d
JOIN "Customer" t ON t.phone = '+' || d.phone AND t.id <> d.id
WHERE cr.customer_id = d.id
  AND d.phone ~ '^225[0-9]{10}$'
  AND cr.status IN ('PENDING', 'IN_REVIEW')
  AND NOT EXISTS (
    SELECT 1 FROM "CardRequest" x
    WHERE x.customer_id = t.id AND x.status IN ('PENDING', 'IN_REVIEW')
  );

-- 3) Demande ouverte restée sur un doublon (le twin avait déjà la sienne) :
--    close proprement pour ne laisser aucune demande orpheline qui « sonne ».
UPDATE "CardRequest" cr
SET status = 'EXPIRED',
    rejection_reason = COALESCE(cr.rejection_reason, 'Fusion de comptes : doublon adhésion site')
FROM "Customer" d
JOIN "Customer" t ON t.phone = '+' || d.phone AND t.id <> d.id
WHERE cr.customer_id = d.id
  AND d.phone ~ '^225[0-9]{10}$'
  AND cr.status IN ('PENDING', 'IN_REVIEW');

-- 4) Cartes Nation du doublon → twin. Si le twin possède déjà une carte ACTIVE,
--    la carte déplacée est révoquée (jamais deux actives sur un même client).
UPDATE "NationCard" nc
SET customer_id = t.id,
    status = CASE
      WHEN nc.status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM "NationCard" x
        WHERE x.customer_id = t.id AND x.status = 'ACTIVE'
      )
      THEN 'REVOKED'::"NationCardStatus"
      ELSE nc.status
    END
FROM "Customer" d
JOIN "Customer" t ON t.phone = '+' || d.phone AND t.id <> d.id
WHERE nc.customer_id = d.id
  AND d.phone ~ '^225[0-9]{10}$';

-- 5) Backfill de l'identité du twin depuis le doublon (uniquement les champs vides :
--    on n'écrase jamais ce que le client a renseigné dans l'app).
UPDATE "Customer" t
SET first_name       = COALESCE(NULLIF(TRIM(t.first_name), ''), d.first_name),
    last_name        = COALESCE(NULLIF(TRIM(t.last_name), ''), d.last_name),
    profile_type     = COALESCE(t.profile_type, d.profile_type),
    whatsapp_opt_in  = (COALESCE(t.whatsapp_opt_in, false) OR COALESCE(d.whatsapp_opt_in, false)),
    whatsapp_opt_in_at = COALESCE(t.whatsapp_opt_in_at, d.whatsapp_opt_in_at)
FROM "Customer" d
WHERE t.phone = '+' || d.phone
  AND t.id <> d.id
  AND d.phone ~ '^225[0-9]{10}$'
  AND d.entity_status <> 'DELETED';

-- 6) Soft-delete du doublon (après transfert). Sa graphie `225…` reste en place
--    (pas de collision : chaîne distincte de `+225…`) et les lookups runtime
--    excluent DELETED.
UPDATE "Customer" d
SET entity_status = 'DELETED'
FROM "Customer" t
WHERE t.phone = '+' || d.phone
  AND t.id <> d.id
  AND d.phone ~ '^225[0-9]{10}$';

-- 7) Comptes `225…` SANS twin (adhésion jamais suivie d'un login app) :
--    normalisation directe vers le format canonique.
UPDATE "Customer" c
SET phone = '+' || c.phone
WHERE c.phone ~ '^225[0-9]{10}$'
  AND NOT EXISTS (SELECT 1 FROM "Customer" t WHERE t.phone = '+' || c.phone);
