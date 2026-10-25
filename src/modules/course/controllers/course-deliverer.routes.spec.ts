/**
 * Routes du livreur (relecture du 25/10). L'annulation d'une course et
 * « Colis récupérés » ne sont plus appelées par l'appli depuis mai : la
 * caisse valide le retrait (code dicté), le serveur relance une course
 * abandonnée (annulation automatique). Ouvertes, elles laissaient un livreur
 * annuler la course d'un collègue et ses commandes, ou déclarer remises des
 * commandes que la caisse n'avait pas données.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { CourseDelivererController } from './course-deliverer.controller';

function routes(): string[] {
  const proto = CourseDelivererController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((nom) => nom !== 'constructor' && typeof proto[nom] === 'function')
    .filter((nom) => Reflect.getMetadata(METHOD_METADATA, proto[nom] as object) !== undefined)
    .map((nom) => Reflect.getMetadata(PATH_METADATA, proto[nom] as object) as string);
}

it('ni annulation de la course ni « Colis récupérés » par le livreur', () => {
  expect(routes()).not.toContain(':id/cancel');
  expect(routes()).not.toContain(':id/picked-up');
});

it('les routes de l’appli restent : accepter, refuser, au restaurant, je pars, livraisons', () => {
  expect(routes()).toEqual(
    expect.arrayContaining([
      ':id/accept',
      ':id/refuse',
      ':id/at-restaurant',
      ':id/depart',
      'deliveries/:deliveryId/start',
      'deliveries/:deliveryId/arrived',
      'deliveries/:deliveryId/confirm',
      'deliveries/:deliveryId/fail',
    ]),
  );
});
