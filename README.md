## Tâches à faire

- Vérification de l'expiration des promotions

- Pouvoir récupérer le dernier restaurant qui n'est pas fermé

- Historique des activités du clients (Usage de promotion, points gagnés, points utilisés, points bonus, gains utilisés et gains bonus)

ROADMAP POUR AJOUTER UN NOUVEL EVENEMENT D'ACTION (NOTIFICATION ou EMAIL)

1. Ajouter le listener dans le fichier [module]-listener.service.ts
2. Ajouter le template dans le fichier [module]-[notification/email]-template.service.ts
3. Ajouter l'évènement dans le fichier [module].event.ts
4. Ajouter le service dans le fichier [module].service.ts
5. Ajouter le module dans le fichier [module].module.ts

# USER NOTIFICATION ET EMAIL
- Creation user (Backoffice et lui-même) : OK
- Creation membre (Restaurant et lui-même) : OK
- Activation (Backoffice et lui-même) : En cours
- Desactivation (Backoffice et lui-même) : En cours
- Suppression (Backoffice et lui-même) : En cours

# RESTAURANT NOTIFICATION ET EMAIL
- Creation restaurant (Backoffice et lui-même) : OK
- Activation restaurant (Backoffice et lui-même) : En cours
- Desactivation restaurant (Backoffice et lui-même) : En cours
- Suppression restaurant (Backoffice et lui-même) : En cours

# CATEGORIE NOTIFICATION ET EMAIL
- Creation categorie (Backoffice et lui-même) : OK
- Mise à jour categorie (Backoffice et lui-même) : OK
- Activation categorie (Backoffice et lui-même) : En cours
- Desactivation categorie (Backoffice et lui-même) : En cours
- Suppression categorie (Backoffice et lui-même) : En cours

# PLAT NOTIFICATION ET EMAIL
- Creation plat (Backoffice et lui-même) : OK
- Mise à jour plat (Backoffice et lui-même) : OK
- Activation plat (Backoffice et lui-même) : En cours
- Desactivation plat (Backoffice et lui-même) : En cours
- Suppression plat (Backoffice et lui-même) : En cours

# PROMOTION NOTIFICATION ET EMAIL
- Utilisation promotion (Client) : OK
- Creation promotion (Backoffice, Restaurant, Client) : OK
- Mise à jour promotion (Backoffice, Restaurant) : OK
- Suppression promotion (Backoffice, Restaurant, Client) : OK

# COMMANDE NOTIFICATION ET EMAIL
- Creation commande (Restaurant et lui-même) : OK
- Mise à jour du statut commande (Restaurant et lui-même) : OK
- Mise à jour commande (Restaurant et lui-même) : En cours
- Suppression commande (Restaurant et lui-même) : En cours

# POINTS DE FIDELITE NOTIFICATION ET EMAIL
- Gagnez des points (Par bonus, commande) (Client) : OK 
- Utilisez des points (Client) : OK 
- Niveau atteint (Client) : OK 
- Points expirés (Client) : OK

- SI le restaurant choisi n'a pas un plat, il faudrait renvoyer la commande à un autre restaurant.