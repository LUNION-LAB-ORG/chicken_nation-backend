/**
 * Routes publiques de lecture avant commande (frais, itinéraire, état de la
 * livraison).
 *
 * Nest déclare les routes dans l'ordre des méthodes du contrôleur. Une route
 * fixe placée APRÈS `@Get(':id')` serait prise pour un identifiant de
 * commande, et tomberait sur la garde du personnel : le site et
 * l'application recevraient un 401 au lieu de la réponse.
 */

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { OrderService } from '../services/order.service';
import { OrderController } from './order.controller';

const ROUTES_PUBLIQUES = [
  ['/itineraire-livraison', 'obtenirItineraireLivraison'],
  ['/frais-livraison', 'obtenirFraisLivraison'],
  ['/livraison-disponible', 'obtenirDisponibiliteLivraison'],
] as const;

const methodes = Object.getOwnPropertyNames(OrderController.prototype);
const handler = (nom: string) => (OrderController.prototype as unknown as Record<string, object>)[nom];

describe('Routes publiques de commande', () => {
  it.each(ROUTES_PUBLIQUES)('GET %s est déclarée AVANT GET :id', (chemin, nom) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler(nom))).toBe(chemin);
    expect(Reflect.getMetadata(METHOD_METADATA, handler(nom))).toBe(RequestMethod.GET);
    expect(methodes.indexOf(nom)).toBeGreaterThanOrEqual(0);
    expect(methodes.indexOf(nom)).toBeLessThan(methodes.indexOf('findOne'));
  });

  it.each(ROUTES_PUBLIQUES)('GET %s ne demande aucune connexion', (_chemin, nom) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(nom))).toBeUndefined();
  });
});

describe('OrderService.obtenirDisponibiliteLivraison', () => {
  const monter = (blocage: { disabled: boolean; message: string }) => {
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, {
      deliveryFeeHelper: { isAppDeliveryDisabled: jest.fn().mockResolvedValue(blocage) },
    });
    return service;
  };

  it('livraison ouverte : disponible, sans message', async () => {
    await expect(monter({ disabled: false, message: '' }).obtenirDisponibiliteLivraison()).resolves.toEqual({
      disponible: true,
      message: null,
    });
  });

  it('livraison coupée : le message du réglage, tel que le refus de createv2 le donnerait', async () => {
    const message = 'La livraison reprend à 18 h. Choisissez « À emporter ».';
    await expect(monter({ disabled: true, message }).obtenirDisponibiliteLivraison()).resolves.toEqual({
      disponible: false,
      message,
    });
  });
});
