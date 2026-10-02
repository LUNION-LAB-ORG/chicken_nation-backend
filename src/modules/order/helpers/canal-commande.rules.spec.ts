/**
 * Canal d'une commande saisie par `OrderService.create()`, et sa lecture dans
 * les exports.
 *
 * Signalement du 02/10 : les ventes au comptoir (compte de restaurant)
 * partaient CALL_CENTER. Si l'un de ces tests casse, relisez
 * canal-commande.rules.ts avant de l'adapter.
 */

import { OrderChannel, UserType } from '@prisma/client';
import { canalDeSaisie, libelleSource } from './canal-commande.rules';

describe('canalDeSaisie', () => {
  it("sans auteur (ancienne route client des applications) : APP", () => {
    expect(canalDeSaisie(undefined, undefined)).toBe(OrderChannel.APP);
    expect(canalDeSaisie(null, null)).toBe(OrderChannel.APP);
    expect(canalDeSaisie('', { type: UserType.BACKOFFICE })).toBe(OrderChannel.APP);
  });

  it("l'auteur ne compte pas sans user_id : un client connecté reste APP", () => {
    // Sur la route client, req.user est le CLIENT, qui n'a pas de `type`.
    expect(canalDeSaisie(undefined, { type: UserType.RESTAURANT })).toBe(OrderChannel.APP);
  });

  it('compte de point de vente (caissier, gérant) : RESTAURANT', () => {
    expect(canalDeSaisie('u1', { type: UserType.RESTAURANT })).toBe(OrderChannel.RESTAURANT);
  });

  it("compte du siège (centre d'appels, administrateur) : CALL_CENTER", () => {
    expect(canalDeSaisie('u1', { type: UserType.BACKOFFICE })).toBe(OrderChannel.CALL_CENTER);
  });

  it("auteur inconnu mais user_id présent : CALL_CENTER, comme avant ce correctif", () => {
    expect(canalDeSaisie('u1', undefined)).toBe(OrderChannel.CALL_CENTER);
    expect(canalDeSaisie('u1', { type: null })).toBe(OrderChannel.CALL_CENTER);
  });
});

describe('libelleSource (exports Excel)', () => {
  it('site web et comptoir se lisent sur le canal, quel que soit auto', () => {
    expect(libelleSource({ channel: OrderChannel.WEB, auto: true })).toBe('Site web');
    expect(libelleSource({ channel: OrderChannel.WEB, auto: false })).toBe('Site web');
    expect(libelleSource({ channel: OrderChannel.RESTAURANT, auto: false })).toBe('Manuel');
    expect(libelleSource({ channel: OrderChannel.RESTAURANT, auto: true })).toBe('Manuel');
  });

  it("le reste garde l'ancienne lecture par auto", () => {
    expect(libelleSource({ channel: OrderChannel.APP, auto: true })).toBe('Appli');
    // Commande de l'application reprise au téléphone.
    expect(libelleSource({ channel: OrderChannel.APP, auto: false })).toBe('Manuel');
    expect(libelleSource({ channel: OrderChannel.CALL_CENTER, auto: false })).toBe('Manuel');
  });

  it('commandes antérieures au canal (channel vide) : lecture par auto', () => {
    expect(libelleSource({ channel: null, auto: true })).toBe('Appli');
    expect(libelleSource({ channel: null, auto: false })).toBe('Manuel');
    expect(libelleSource({})).toBe('Manuel');
  });
});
