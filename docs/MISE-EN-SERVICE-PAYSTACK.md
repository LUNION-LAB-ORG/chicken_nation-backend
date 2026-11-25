# Mise en service de Paystack

Paiement en ligne de l'appli et du site par Paystack, chaque restaurant
encaissant sur son sous-compte. Rien ne change tant que le prestataire reste
« KKiaPay » dans le back-office.

## Ce que fait le serveur

- Le paiement part sur le sous-compte du restaurant (`subaccount`), frais
  Paystack portés par ce sous-compte (`bearer: "subaccount"`). Un sous-compte
  dont la part du compte principal n'est pas à 0 % est refusé.
- Montants en XOF, envoyés multipliés par 100 (règle de Paystack).
- Moyens : carte, Orange Money, MTN, Wave. Pas de Moov Money chez Paystack.
- La commande est confirmée après vérification chez Paystack, par trois
  chemins : le retour du client, le webhook, et un filet toutes les 5 minutes
  pour les webhooks perdus.
- Remboursement depuis l'onglet Paiement d'une commande. Paystack le traite
  souvent en différé : le paiement passe « Remboursé » quand Paystack l'annonce.

## Ordre de déploiement

1. Serveur (une migration, additive : `20261125120000_paystack`).
2. Back-office.
3. Site.
4. Appli : mise à jour publiée. Tant qu'un client n'a pas la mise à jour et
   que Paystack est actif, son appli lui demande de se mettre à jour.

## Réglages, dans l'ordre

1. Tableau de bord Paystack, Settings, API Keys & Webhooks : copier la clé
   secrète (`sk_live_…`) et coller dans « Webhook URL » l'adresse affichée au
   back-office (`https://api-private.chicken-nation.com/api/v1/paystack/webhook`).
2. Back-office, Paramètres, Paiements, carte « Paystack » : coller la clé
   secrète, « Enregistrer les clés ». Le badge « Réel » apparaît.
3. Choisir le sous-compte de chaque restaurant. Refus « laisse une part au
   compte principal » : mettre le pourcentage à 0 sur ce sous-compte dans le
   tableau de bord Paystack, puis « Relire chez Paystack ».
4. Carte « Paiement en ligne » : choisir « Paystack », confirmer.
5. Faire un petit paiement réel dans un restaurant, puis le rembourser.

Retour en arrière : rechoisir « KKiaPay » (effet immédiat). L'interrupteur
coupe tout paiement en ligne ; l'appli ne peut alors plus commander (toutes
ses commandes se paient en ligne), le site garde le paiement à la livraison.

## Variables d'environnement (facultatives)

Les valeurs par défaut sont celles de la production.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `API_PUBLIC_URL` | Adresse publique de l'API (retour après paiement dans l'appli) | `https://api-private.chicken-nation.com` |
| `SITE_PUBLIC_URL` | Adresse du site (retour après paiement sur le site) | `https://www.chicken-nation.com` |
| `APP_DEEPLINK_SCHEME` | Schéma des liens de l'appli | `chickennation` |
| `PAYSTACK_SECRET_KEY` | Clé secrète si elle n'est pas posée au back-office | aucune |
| `PAYSTACK_WEBHOOK_SECRET` | Secret de signature `whsec_…` (nouveau schéma de Paystack) | aucun |
| `PAYSTACK_CONTROLE_IP` | `true` : n'accepter les webhooks que des IP de Paystack (demande que le serveur voie la vraie IP) | non |
| `PAYSTACK_API_URL` | Faux Paystack local, ignoré en production | aucun |

## À vérifier au premier paiement réel

- Le montant net arrive bien sur le sous-compte, et rien sur le compte principal.
- Le premier remboursement : sur quel solde Paystack le prélève (la
  documentation ne le dit pas pour un paiement partagé).
