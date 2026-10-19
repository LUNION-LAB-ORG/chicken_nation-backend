/**
 * Canal d'une commande saisie par `OrderService.create()`, et sa lecture dans
 * les exports.
 *
 * Signalement du 02/10 : les ventes au comptoir (compte de restaurant)
 * partaient CALL_CENTER. Si l'un de ces tests casse, relisez
 * canal-commande.rules.ts avant de l'adapter.
 */

import { OrderChannel, OrderStatus, Prisma, UserType } from '@prisma/client';
import { canalDeCommande } from 'src/modules/statistics/helpers/canal-commande.helper';
import {
  SOURCES_COMMANDE,
  ajouterAuEt,
  canalDeSaisie,
  conditionSource,
  conditionsFiltreSource,
  libelleSource,
  sourceDeCommande,
} from './canal-commande.rules';
import { rendueParLaBase } from './where-sql.simule-spec';

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
  it("site web et comptoir : la lecture par auto, comme avant le 02/10 (demande du 03/10)", () => {
    expect(libelleSource({ channel: OrderChannel.WEB, auto: true })).toBe('Appli');
    expect(libelleSource({ channel: OrderChannel.WEB, auto: false })).toBe('Téléphone');
    expect(libelleSource({ channel: OrderChannel.RESTAURANT, auto: false })).toBe('Téléphone');
    expect(libelleSource({ channel: OrderChannel.RESTAURANT, auto: true })).toBe('Appli');
  });

  it("le personnel reste « Téléphone », jamais « Manuel »", () => {
    expect(libelleSource({ channel: OrderChannel.APP, auto: true })).toBe('Appli');
    expect(libelleSource({ channel: OrderChannel.APP, auto: false })).toBe('Téléphone');
    expect(libelleSource({ channel: OrderChannel.CALL_CENTER, auto: false })).toBe('Téléphone');
  });

  it('commandes antérieures au canal (channel vide) : lecture par auto', () => {
    expect(libelleSource({ channel: null, auto: true })).toBe('Appli');
    expect(libelleSource({ channel: null, auto: false })).toBe('Téléphone');
    expect(libelleSource({})).toBe('Téléphone');
  });
});

// ---------------------------------------------------------------------------
// Filtre « source » de la liste des commandes (demande du 19/10)
// ---------------------------------------------------------------------------

describe('filtre « source » : site, appli, téléphone', () => {
  const CANAUX: (OrderChannel | null | undefined)[] = [
    OrderChannel.APP,
    OrderChannel.WEB,
    OrderChannel.CALL_CENTER,
    OrderChannel.RESTAURANT,
    null,
    undefined,
  ];
  /** `auto` est obligatoire en base ; `null` n'existe qu'en mémoire. */
  const AUTO_EN_BASE = [true, false];

  /** Toutes les commandes possibles en base (canal vide compris). */
  const COMMANDES = CANAUX.filter((c) => c !== undefined).flatMap((channel) =>
    AUTO_EN_BASE.map((auto) => ({ channel, auto })),
  );

  it('sourceDeCommande : la règle de la demande, cas par cas', () => {
    expect(sourceDeCommande({ channel: OrderChannel.WEB, auto: true })).toBe('site');
    expect(sourceDeCommande({ channel: OrderChannel.WEB, auto: null })).toBe('site');
    // Commande du site reprise au téléphone : « Par téléphone » (« Manuel » à l'écran).
    expect(sourceDeCommande({ channel: OrderChannel.WEB, auto: false })).toBe('telephone');
    expect(sourceDeCommande({ channel: OrderChannel.APP, auto: true })).toBe('appli');
    // Anciennes commandes, sans canal : « Par application ».
    expect(sourceDeCommande({ channel: null, auto: true })).toBe('appli');
    expect(sourceDeCommande({ auto: true })).toBe('appli');
    expect(sourceDeCommande({ channel: OrderChannel.CALL_CENTER, auto: false })).toBe('telephone');
    expect(sourceDeCommande({ channel: OrderChannel.RESTAURANT, auto: false })).toBe('telephone');
    expect(sourceDeCommande({ channel: null, auto: false })).toBe('telephone');
  });

  it('jumelle de canalDeCommande (statistiques) sur toutes les combinaisons, auto nul compris', () => {
    const attendu = { WEB: 'site', APP: 'appli', CALL_CENTER: 'telephone' } as const;
    for (const channel of CANAUX) {
      for (const auto of [true, false, null]) {
        expect(sourceDeCommande({ channel, auto })).toBe(attendu[canalDeCommande({ channel, auto })]);
      }
    }
  });

  it('conditionSource (Prisma) rend exactement les commandes de sourceDeCommande, canal vide compris', () => {
    for (const source of SOURCES_COMMANDE) {
      for (const commande of COMMANDES) {
        expect({ source, commande, rendue: rendueParLaBase(commande, conditionSource(source)) }).toEqual({
          source,
          commande,
          rendue: sourceDeCommande(commande) === source,
        });
      }
    }
  });

  it('chaque commande a une seule source, et les trois couvrent tout', () => {
    for (const commande of COMMANDES) {
      const sources = SOURCES_COMMANDE.filter((s) => rendueParLaBase(commande, conditionSource(s)));
      expect(sources).toHaveLength(1);
    }
  });

  it("le piège des valeurs nulles : `channel: { not: 'WEB' }` seul écarterait les anciennes commandes", () => {
    const ancienne = { channel: null, auto: true };
    expect(rendueParLaBase(ancienne, { auto: true, channel: { not: OrderChannel.WEB } })).toBe(false);
    expect(rendueParLaBase(ancienne, conditionSource('appli'))).toBe(true);
  });

  it('conditionsFiltreSource : les brouillons écartés pour le site et l’application, sauf demande', () => {
    const pasEnAttente = { status: { not: OrderStatus.PENDING } };
    expect(conditionsFiltreSource('site', { avecBrouillons: false })).toEqual([
      conditionSource('site'),
      pasEnAttente,
    ]);
    expect(conditionsFiltreSource('appli', { avecBrouillons: false })).toEqual([
      conditionSource('appli'),
      pasEnAttente,
    ]);
    expect(conditionsFiltreSource('site', { avecBrouillons: true })).toEqual([conditionSource('site')]);
    expect(conditionsFiltreSource('appli', { avecBrouillons: true })).toEqual([conditionSource('appli')]);
    // La saisie du personnel garde tout, comme auto=false.
    expect(conditionsFiltreSource('telephone', { avecBrouillons: false })).toEqual([{ auto: false }]);
  });

  it('ajouterAuEt garde les conditions déjà posées', () => {
    const vide: Prisma.OrderWhereInput = {};
    ajouterAuEt(vide, [{ auto: false }]);
    expect(vide.AND).toEqual([{ auto: false }]);

    const objet: Prisma.OrderWhereInput = { AND: { paied: true } };
    ajouterAuEt(objet, [{ auto: false }]);
    expect(objet.AND).toEqual([{ paied: true }, { auto: false }]);

    const liste: Prisma.OrderWhereInput = { AND: [{ paied: true }], OR: [{ auto: true }] };
    ajouterAuEt(liste, [{ auto: false }]);
    expect(liste).toEqual({ AND: [{ paied: true }, { auto: false }], OR: [{ auto: true }] });
  });
});
