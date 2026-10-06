-- Reprise : un établissement renseigné vaut déclaration d'études.
--
-- Les formulaires (application et site) ne demandent l'établissement qu'après
-- un « Oui » à « Êtes-vous étudiant ou élève ? ». Un établissement sans
-- profil est donc une réponse perdue en route, pas un choix. Ces demandes
-- s'affichaient « Étudiant : Non » juste à côté du nom de leur école.
--
-- La dérivation est désormais faite à l'écriture (CardRequestService.createRequest
-- et AdhesionService) : cette migration ne reprend que l'existant.
UPDATE "CardRequest"
SET profile_type = 'ETUDIANT'
WHERE profile_type IS NULL
  AND institution IS NOT NULL
  AND btrim(institution) <> '';

-- Propage au CLIENT, mais UNIQUEMENT pour les demandes reprises ci-dessus et
-- seulement si le client n'a aucun profil : c'est `Customer.profile_type` que
-- lit l'application pour débloquer les menus étudiants. On ne touche à aucun
-- client qui a déjà un profil, ni à ceux dont la demande était déjà ETUDIANT
-- (leur profil est posé à l'adhésion ou à l'approbation).
UPDATE "Customer" c
SET profile_type = 'ETUDIANT'
FROM "CardRequest" cr
WHERE cr.customer_id = c.id
  AND cr.profile_type = 'ETUDIANT'
  AND cr.institution IS NOT NULL
  AND btrim(cr.institution) <> ''
  AND c.profile_type IS NULL;

-- ⚠️ Les CARTES déjà émises ne sont PAS touchées. `NationCard.is_student`
-- pilote le liseré jaune d'une image déjà générée et remise au client
-- (`card_image_url`) : basculer le booléen seul ferait mentir la base sur ce
-- que porte la carte. Une carte concernée se régénère depuis le backoffice,
-- qui refait l'image ET le marqueur ensemble.
