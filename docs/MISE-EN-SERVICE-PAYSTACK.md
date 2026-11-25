# Mise en service de Paystack

Paiement en ligne de l'appli et du site par Paystack, chaque restaurant
encaissant sur son sous-compte. Rien ne change tant que le prestataire reste
« KKiaPay » dans le back-office.

## Ce que fait le serveur

- Le paiement part sur le sous-compte du restaurant (`subaccount`), frais
  Paystack portés par ce sous-compte (`bearer: "subaccount"`). Le compte
  principal ne peut pas garder plus que le « supplément » réglé au back-office :
  un sous-compte qui lui laisse davantage est refusé. (Au tableau de bord
  Paystack, « 99 % » est la part du restaurant : 1 % pour le compte principal.)
- Frais ajoutés au client : Paystack n'ajoute rien au montant. Le client
  choisit Mobile Money ou carte avant de payer, et paie la commande plus le
  taux de ce moyen et le supplément. Défauts : Mobile Money 2,3 %, carte
  3,8 %, supplément 1 %, tous réglables au back-office. Arrondi au franc
  supérieur. La page de paiement ne propose ensuite que le moyen choisi.
  Carte locale ou internationale : inconnue avant la saisie de la carte, un
  seul taux « carte » s'applique (Paystack prend 4,5 % sur une carte
  internationale).
- Sur un paiement, « montant » est la part de la commande, « frais » ce que le
  client a payé en plus, « total » ce qui a été débité.
- Montants en XOF, envoyés multipliés par 100 (règle de Paystack).
- Moyens : carte, Orange Money, MTN, Wave. Pas de Moov Money chez Paystack.
- E-mail : Paystack en exige un. Celui du client s'il est valable, sinon une
  adresse technique (aussi quand Paystack refuse l'adresse du client).
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
3. Vérifier les « Frais ajoutés au client » (Mobile Money, carte, supplément).
4. Choisir le sous-compte de chaque restaurant. Refus « laisse X % au compte
   principal » : corriger le pourcentage du sous-compte dans le tableau de
   bord Paystack (ou le supplément), puis « Relire chez Paystack ».
5. Carte « Paiement en ligne » : choisir « Paystack », confirmer.
6. Faire un petit paiement réel dans un restaurant, puis le rembourser.

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

## Vérifié en mode test (25/11, clé `sk_test_`)

- Mobile Money (Wave) : commande de 4 550 F payée 4 701 F. Paystack annonce
  108 F de frais (2,3 %), 0 F pour le compte principal, 4 593 F pour le
  sous-compte (sous-compte à 100 %).
- Carte de test : 4 550 F payés 4 769 F, frais Paystack 3,80 %. Un refus de
  carte laisse le client sur la page Paystack, qui propose de réessayer.
- Remboursement : accepté pour tout ce que le client a payé, « entièrement
  déduit » dès la demande, puis en attente de traitement.
- Un e-mail au domaine fictif est refusé par Paystack (« must be a valid
  email ») : le serveur repart alors avec l'adresse technique.

## À vérifier au premier paiement réel

- Le webhook (il ne peut pas atteindre un poste local).
- Le montant net arrive bien sur le sous-compte ; la part du compte principal
  est celle attendue.
- Le premier remboursement : sur quel solde Paystack le prélève (compte
  principal ou sous-compte), et son délai.
