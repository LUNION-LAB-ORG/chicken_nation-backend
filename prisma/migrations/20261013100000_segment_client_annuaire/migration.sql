-- L'onglet Contacts doit réunir TOUS les clients du système.
--
-- Le CRM ne créait de fiche que pour un inscrit sans commande ou un client
-- inactif depuis 30 jours. Depuis que la page Clients a été versée dans le CRM,
-- un client qui a commandé ce mois-ci n'apparaissait donc plus nulle part.
--
-- Deux valeurs additives, et rien d'autre ici : la reprise des clients
-- existants est faite par le rattrapage du CRM, qui sait déjà calculer la clé
-- téléphone et éviter les doublons de numéro.
--
-- ⚠️ `NON_DEMARCHE` reste HORS de STATUTS_OUVERTS : ces fiches ne comptent dans
-- aucun portefeuille et n'entrent dans aucune file d'agent. Et surtout, elles ne
-- sont PAS marquées « CONVERTI » : un client qui a commandé sans qu'on l'appelle
-- fausserait les taux de conversion et les statistiques de campagne.
ALTER TYPE "CrmSegment" ADD VALUE IF NOT EXISTS 'CLIENT';
ALTER TYPE "CrmStatus" ADD VALUE IF NOT EXISTS 'NON_DEMARCHE';
