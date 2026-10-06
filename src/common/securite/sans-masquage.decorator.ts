import { SetMetadata } from '@nestjs/common';

export const SANS_MASQUAGE = 'sansMasquage';

/**
 * Dispense une route (ou un contrôleur entier) du masquage des coordonnées.
 *
 * Réservé aux routes où l'agent lit SON PROPRE compte : connexion, jeton,
 * fiche personnelle. Deux raisons, la seconde bien plus grave que la
 * première :
 *  - masquer sa propre adresse n'a aucun sens, il la connaît ;
 *  - la fiche personnelle se MODIFIE (`PATCH /users`, sans permission car
 *    c'est du libre-service). Le formulaire se préremplit avec ce que
 *    l'interface a reçu : masquer la réponse écrirait les pointillés en base
 *    au premier enregistrement, et l'adresse serait perdue pour de bon.
 *
 * ⚠️ Ne jamais poser ce décorateur sur une route qui rend les coordonnées de
 * QUELQU'UN D'AUTRE, c'est exactement ce que le masquage existe pour couvrir.
 */
export const SansMasquage = () => SetMetadata(SANS_MASQUAGE, true);
