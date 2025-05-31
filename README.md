## TODO :PROMOTION ET POINT DE FIDELITE
- Prendre en compte les promotions dans la commande pour une réduction automatique OK
- Ajouter des points de fidélité de commande automatiquement OK
- Ajouter des crons pour les promotions (expiration, activation, )
- Ajouter des crons pour les points de fidélité (expiration, activation)

## TODO : NOTIFICATION

- Notification en temps réel

## TODO : COMMANDE
- Simuler la livraison avec des crons les commandes prêtes à livrer (
    PICKED_UP : EN LIVRAISON
    COLLECTED : COLLECTÉ PAR LE CLIENT
    )
- Commande en temps réel

### PROCEDURE À LIVRER

Commande à livrer   : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> PICKED_UP -> COLLECTED -> COMPLETED
                                                         -> CANCELLED

Commande à emporter : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> COLLECTED -> COMPLETED
                                                         -> CANCELLED

Commande à table : PENDING -> ACCEPTED -> IN_PROGRESS -> READY -> COLLECTED -> COMPLETED

## CREATION DE COMMANDE
- Ajouter des points de fidélité de commande automatiquement

## NOTIFICATION
- Ajouter les icônes de promotions

# Automatisation
- Utilisation des points de fidélité
- Ajout des points de fidélité
- Utilisation d'une promotion
