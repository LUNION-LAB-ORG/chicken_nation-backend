import { UserRole } from '@prisma/client';

/**
 * Rôles qui CONSULTENT le suivi des livraisons : les courses, les livreurs et
 * leur planning.
 *
 * ⚠️ À poser sur les routes de LECTURE uniquement. Les trois contrôleurs
 * concernés (`courses`, `deliverers`, `schedule`) restent `@UserRoles(ADMIN)`
 * au niveau de la classe, et le garde fait primer la méthode sur la classe :
 * les GET s'ouvrent, tout ce qui agit reste à l'administrateur. Forcer une
 * course, suspendre un livreur ou générer un planning ne bougent pas.
 *
 * ⚠️ Ces écrans ne sont pas gardés par une permission mais par une LISTE DE
 * RÔLES. Ajouter `LIVREURS: [READ]` à un rôle fait donc apparaître l'entrée au
 * menu sans ouvrir l'API : les deux doivent bouger ensemble.
 */
export const ROLES_SUIVI_LIVRAISON = [UserRole.ADMIN, UserRole.LIVRAISON_OPS] as const;
