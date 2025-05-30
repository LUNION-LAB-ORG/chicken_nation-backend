# TODO

- Simuler la livraison avec des crons
- Ajouter des notifications un peu partout
- Déclencher du temps réel avec les notifications
- Envoyer les données en temps réel (commandes, notification,audit)
- Ajouter des statistiques

## TODO :PROMOTION ET POINT DE FIDELITE
- Prendre en compte les promotions dans la commande
- Ajouter des points de fidélité de commande automatiquement
- Ajouter des crons pour les promotions (expiration, activation, )
- Ajouter des crons pour les points de fidélité (expiration, activation)

## TODO : COMMANDE
- Simuler la livraison avec des crons les commandes prêtes à livrer (
    PICKED_UP : EN LIVRAISON
    COLLECTED : COLLECTÉ PAR LE CLIENT
    )

### PROCEDURE À LIVRER

Commande à livrer   : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> PICKED_UP -> COLLECTED -> COMPLETED
                                                         -> CANCELLED


Commande à emporter : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> COLLECTED -> COMPLETED
                                                         -> CANCELLED


Commande à table : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> COLLECTED -> COMPLETED
                                                    -> CANCELLED


  PENDING // EN ATTENTE
  CANCELLED // ANNULÉ
  ACCEPTED // ACCEPTÉ
  IN_PROGRESS // EN COURS
  READY // PRÊT
  PICKED_UP // EN LIVRAISON
  COLLECTED // COLLECTÉ PAR LE CLIENT
  COMPLETED // TERMINÉ, LE LIVREUR A L'ARGENT