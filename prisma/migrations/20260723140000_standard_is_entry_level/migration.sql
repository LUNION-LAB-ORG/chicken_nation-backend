-- STANDARD devient le niveau d'ENTRÉE du programme de fidélité (décision 23/07).
--
-- Avant : un client démarrait « sans niveau » (loyalty_level NULL) et devait
-- cumuler 300 points de statut pour devenir STANDARD — alors que sa carte de la
-- Nation portait DÉJÀ le badge STANDARD dès l'émission. D'où des écrans qui se
-- contredisaient (« Niveau Standard » ici, « NOUVEAU, 300 pts à cumuler » là) et
-- une zone morte inexplicable pour le client.
--
-- Après : l'échelle est STANDARD → VIP → VVIP. Le seuil Standard passe à 0 et
-- tous les clients sans niveau sont rattachés à STANDARD.
--
-- Additif et idempotent (rejouable sans effet).

-- 1) Seuil d'entrée à 0 sur la configuration active (et les éventuelles autres).
UPDATE "LoyaltyConfig" SET standard_threshold = 0 WHERE standard_threshold <> 0;

-- 2) Rattrapage des clients « sans niveau » → STANDARD. Le compteur annuel
--    status_points n'est PAS touché : seul le palier affiché change, la
--    progression vers VIP reste exacte.
UPDATE "Customer"
SET loyalty_level = 'STANDARD',
    last_level_update = NOW()
WHERE loyalty_level IS NULL
  AND entity_status <> 'DELETED';
