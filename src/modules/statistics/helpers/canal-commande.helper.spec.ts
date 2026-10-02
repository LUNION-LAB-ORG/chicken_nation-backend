/**
 * Canal des commandes dans les statistiques : le site web compté à part, le
 * reste selon la règle historique fondée sur `auto`. Fonctions pures, aucune
 * base.
 */
import { OrderChannel } from '@prisma/client';
import {
  ajouterAuCanal,
  canalDeCommande,
  canalPrefere,
  compteParCanalVide,
} from './canal-commande.helper';

describe('canalDeCommande', () => {
  it('range une commande du site dans WEB, même avec auto vrai', () => {
    expect(canalDeCommande({ auto: true, channel: OrderChannel.WEB })).toBe('WEB');
  });

  it('garde la règle auto pour les commandes antérieures (channel vide)', () => {
    expect(canalDeCommande({ auto: true, channel: null })).toBe('APP');
    expect(canalDeCommande({ auto: false, channel: null })).toBe('CALL_CENTER');
    expect(canalDeCommande({ auto: true })).toBe('APP');
  });

  it('lit auto pour les canaux autres que le site', () => {
    expect(canalDeCommande({ auto: true, channel: OrderChannel.APP })).toBe('APP');
    expect(canalDeCommande({ auto: false, channel: OrderChannel.CALL_CENTER })).toBe(
      'CALL_CENTER',
    );
  });

  it('compte la vente au comptoir avec le centre d\'appels, par auto faux', () => {
    // Valeur écrite en clair : le test ne dépend pas de la version du client Prisma
    expect(canalDeCommande({ auto: false, channel: 'RESTAURANT' as OrderChannel })).toBe(
      'CALL_CENTER',
    );
  });

  it('compte auto vide comme le centre d\'appels', () => {
    expect(canalDeCommande({ auto: null, channel: null })).toBe('CALL_CENTER');
  });
});

describe('ajouterAuCanal', () => {
  it('ventile des commandes et des groupes pondérés sans perdre de total', () => {
    const compte = compteParCanalVide();
    ajouterAuCanal(compte, { auto: true, channel: null });
    ajouterAuCanal(compte, { auto: true, channel: OrderChannel.WEB }, 3);
    ajouterAuCanal(compte, { auto: false, channel: null }, 2);
    ajouterAuCanal(compte, { auto: true, channel: OrderChannel.APP }, 4);

    expect(compte).toEqual({ app: 5, web: 3, callCenter: 2 });
  });
});

describe('canalPrefere', () => {
  it('donne le canal strictement en tête', () => {
    expect(canalPrefere({ app: 1, web: 4, callCenter: 2 })).toBe('WEB');
    expect(canalPrefere({ app: 5, web: 4, callCenter: 2 })).toBe('APP');
    expect(canalPrefere({ app: 0, web: 1, callCenter: 3 })).toBe('CALL_CENTER');
  });

  it('renvoie MIXED en cas d\'égalité en tête ou sans commande', () => {
    expect(canalPrefere({ app: 2, web: 2, callCenter: 1 })).toBe('MIXED');
    expect(canalPrefere({ app: 0, web: 0, callCenter: 0 })).toBe('MIXED');
  });

  it('sans commande du site, donne le même résultat que l\'ancienne comparaison', () => {
    const ancienne = (app: number, call: number) =>
      app > call ? 'APP' : call > app ? 'CALL_CENTER' : 'MIXED';
    for (const [app, call] of [[0, 0], [1, 0], [0, 1], [3, 3], [7, 2], [2, 7]]) {
      expect(canalPrefere({ app, web: 0, callCenter: call })).toBe(ancienne(app, call));
    }
  });
});
