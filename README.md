## Tâches à faire
- Tableau de board Calcul Prix (À revoir)
- Que les commandes terminées qui constinuent le chiffre d'affaire

- Ajout les restaurants concernés dans la promotion
- vérification de l'expiration des promotions

- Pouvoir récupérer le dernier restaurant qui n'est pas fermé

- Plan de fidélité : 6 commandes, plats offerts (à supprimer)

- Module Messagerie (plus tard)

- Est-ce que le numéro de paiement et le numéro du client qui un blocage (Vérification)

- Notification par email:
    - creation et mise à jour catégorie Ok
    - creation et mise à jour plat OK
    - creation et mise à jour promotion Event OK
    - creation et mise à jour commande Event OK
    - creation, mise à jour, desactivation, activation et suppression restaurant Event Ok
    - Nouvel utilisateur, desactivation, activation et suppression Event OK


ROADMAP POUR AJOUTER UN NOUVEL EVENEMENT D'ACTION (NOTIFICATION ou EMAIL)

1. Ajouter le listener dans le fichier [module]-listener.service.ts
2. Ajouter le template dans le fichier [module]-[notification/email]-template.service.ts
3. Ajouter l'évènement dans le fichier [module].event.ts
4. Ajouter le service dans le fichier [module].service.ts
5. Ajouter le module dans le fichier [module].module.ts
