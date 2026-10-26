import { UserRole } from '@prisma/client';

/**
 * Rôles qui CONSULTENT le suivi des livraisons : les courses et les livreurs.
 * Le planning n'en fait plus partie (24/10) : il est gardé par le droit
 * `Modules.PLANNING`, que le manager reçoit pour son restaurant.
 *
 * Le call center y entre le 26/10 (demande du client : « que le call center
 * ait accès à tout le module de livraison »), en LECTURE comme le suivi des
 * livraisons. Compte de siège, il voit tous les restaurants. Il ne reçoit pas
 * pour autant le code client des livraisons sur `/courses` (`delivery_pin`,
 * administrateur seul) : il lit le code de retrait du client dans le tiroir
 * de la commande (`GET /orders/:id/livraison`, `code_client`).
 *
 * ⚠️ À poser sur les routes de LECTURE uniquement. Les deux contrôleurs
 * concernés (`courses`, `deliverers`) restent `@UserRoles(ADMIN)` au niveau de
 * la classe, et le garde fait primer la méthode sur la classe : les GET
 * s'ouvrent, tout ce qui agit reste à l'administrateur. Forcer une course ou
 * suspendre un livreur ne bougent pas.
 *
 * ⚠️ Ces écrans ne sont pas gardés par une permission mais par une LISTE DE
 * RÔLES. Ajouter `LIVREURS: [READ]` à un rôle fait donc apparaître l'entrée au
 * menu sans ouvrir l'API : les deux doivent bouger ensemble.
 */
export const ROLES_SUIVI_LIVRAISON = [UserRole.ADMIN, UserRole.LIVRAISON_OPS, UserRole.CALL_CENTER] as const;
