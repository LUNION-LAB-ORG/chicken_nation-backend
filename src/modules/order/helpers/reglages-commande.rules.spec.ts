import { OrderChannel, OrderType, PaymentMethod } from '@prisma/client';

import {
  CLES_REGLAGES_COMMANDE,
  lireCanauxDuType,
  lireModeReception,
  lirePaiement,
  lireTypeActif,
  modeReception,
  parcoursCommande,
  refusCommande,
  reglagesCommande,
} from './reglages-commande.rules';

/**
 * Types de commande et paiement, réglés au back-office pour l'application et
 * le site (demandes du 26/11).
 */
describe('Types de commande et paiement, application et site', () => {
  it('les réglages, par leur clé : six par type, le parcours, et l’ancien réglage du site', () => {
    expect([...CLES_REGLAGES_COMMANDE].sort()).toEqual(
      [
        'order_type_livraison',
        'order_type_emporter',
        'order_type_sur_place',
        'order_paiement_livraison',
        'order_paiement_emporter',
        'order_paiement_sur_place',
        'order_paiement_reception',
        'order_paiement_livraison_site',
      ].sort(),
    );
  });

  it('rien de réglé : livraison et à emporter proposés, pas de sur place ; la livraison garde le paiement à la livraison du site', () => {
    const r = reglagesCommande({});
    // L'ancien réglage du site, absent, valait « proposé » : la livraison se
    // paie en ligne ou à la livraison, pour le site comme pour l'application.
    expect(r.DELIVERY).toEqual({ actif: true, paiement: 'LES_DEUX', message: null });
    expect(r.PICKUP).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
    expect(r.TABLE).toMatchObject({ actif: false, paiement: 'EN_LIGNE' });
    expect(r.TABLE.message).toContain("n'est pas proposée");
  });

  it('ancien réglage du site coupé : la livraison se paie en ligne seulement, tant que le nouveau n’est pas enregistré', () => {
    expect(reglagesCommande({ order_paiement_livraison_site: '0' }).DELIVERY.paiement).toBe('EN_LIGNE');
    expect(reglagesCommande({ order_paiement_livraison_site: '1' }).DELIVERY.paiement).toBe('LES_DEUX');
    // Le nouveau réglage, une fois enregistré, l'emporte dans les deux sens.
    expect(
      reglagesCommande({ order_paiement_livraison_site: '0', order_paiement_livraison: 'LES_DEUX' }).DELIVERY.paiement,
    ).toBe('LES_DEUX');
    expect(
      reglagesCommande({ order_paiement_livraison_site: '1', order_paiement_livraison: 'EN_LIGNE' }).DELIVERY.paiement,
    ).toBe('EN_LIGNE');
    // Il ne touche que la livraison.
    expect(reglagesCommande({ order_paiement_livraison_site: '1' }).PICKUP.paiement).toBe('EN_LIGNE');
  });

  it('lecture d’un interrupteur : « 1 », « oui » proposé ; « 0 » et l’illisible non ; vide : la valeur par défaut', () => {
    expect(lireTypeActif('1', false)).toBe(true);
    expect(lireTypeActif(' Oui ', false)).toBe(true);
    expect(lireTypeActif('0', true)).toBe(false);
    expect(lireTypeActif('peut-être', true)).toBe(false);
    expect(lireTypeActif('', true)).toBe(true);
    expect(lireTypeActif(null, false)).toBe(false);
    expect(lireTypeActif(undefined, true)).toBe(true);
  });

  it('lecture du paiement : les trois modes ; absent ou illisible : la valeur par défaut', () => {
    expect(lirePaiement('LES_DEUX')).toBe('LES_DEUX');
    expect(lirePaiement(' a_la_reception ')).toBe('A_LA_RECEPTION');
    expect(lirePaiement('EN_LIGNE')).toBe('EN_LIGNE');
    expect(lirePaiement('especes')).toBe('EN_LIGNE');
    expect(lirePaiement(null)).toBe('EN_LIGNE');
    expect(lirePaiement(null, 'LES_DEUX')).toBe('LES_DEUX');
  });

  it('chaque type se règle à part', () => {
    const r = reglagesCommande({
      order_type_livraison: '0',
      order_type_sur_place: '1',
      order_paiement_emporter: 'LES_DEUX',
      order_paiement_sur_place: 'A_LA_RECEPTION',
    });
    expect(r.DELIVERY.actif).toBe(false);
    expect(r.PICKUP).toEqual({ actif: true, paiement: 'LES_DEUX', message: null });
    expect(r.TABLE).toEqual({ actif: true, paiement: 'A_LA_RECEPTION', message: null });
  });

  it('coupure temporaire de la livraison : la livraison n’est plus proposée, avec le message de la coupure', () => {
    const r = reglagesCommande({}, { disabled: true, message: 'Livraison suspendue ce soir.' });
    expect(r.DELIVERY).toEqual({ actif: false, paiement: 'LES_DEUX', message: 'Livraison suspendue ce soir.' });
    expect(r.PICKUP.actif).toBe(true);
    // Coupure levée : la livraison revient.
    expect(reglagesCommande({}, { disabled: false, message: '' }).DELIVERY.actif).toBe(true);
  });

  // « on doit cocher site web ou appli » (26/11) : un type se coche par canal.
  describe('types cochés par canal : application, site web', () => {
    it('lecture des canaux : liste, « 1 » les deux, « 0 » aucun, vide la valeur par défaut', () => {
      const LES_DEUX = ['APP', 'WEB'];
      expect(lireCanauxDuType('APP,WEB', [])).toEqual(LES_DEUX);
      expect(lireCanauxDuType('web, app', [])).toEqual(LES_DEUX);
      expect(lireCanauxDuType('APP', LES_DEUX as never)).toEqual(['APP']);
      expect(lireCanauxDuType(' site ', [])).toEqual(['WEB']);
      expect(lireCanauxDuType('appli', [])).toEqual(['APP']);
      // Les valeurs d'avant les cases à cocher.
      expect(lireCanauxDuType('1', [])).toEqual(LES_DEUX);
      expect(lireCanauxDuType('oui', [])).toEqual(LES_DEUX);
      expect(lireCanauxDuType('0', LES_DEUX as never)).toEqual([]);
      // Absent ou vide : la valeur par défaut du type.
      expect(lireCanauxDuType(null, LES_DEUX as never)).toEqual(LES_DEUX);
      expect(lireCanauxDuType('', ['APP'])).toEqual(['APP']);
      expect(lireCanauxDuType(undefined, [])).toEqual([]);
      // Illisible : nulle part (une saisie qu'on ne comprend pas n'ouvre rien).
      expect(lireCanauxDuType('partout', LES_DEUX as never)).toEqual([]);
    });

    it('rien de réglé : livraison et à emporter sur les deux canaux, sur place nulle part', () => {
      for (const canal of ['APP', 'WEB'] as const) {
        const r = reglagesCommande({}, null, canal);
        expect({ canal, livraison: r.DELIVERY.actif, emporter: r.PICKUP.actif, surPlace: r.TABLE.actif }).toEqual({
          canal,
          livraison: true,
          emporter: true,
          surPlace: false,
        });
      }
    });

    it('type coché pour un seul canal : proposé là, refusé ailleurs avec son message', () => {
      const valeurs = { order_type_emporter: 'APP', order_type_livraison: 'WEB', order_type_sur_place: 'APP' };
      const appli = reglagesCommande(valeurs, null, 'APP');
      const site = reglagesCommande(valeurs, null, 'WEB');
      expect([appli.PICKUP.actif, site.PICKUP.actif]).toEqual([true, false]);
      expect([appli.DELIVERY.actif, site.DELIVERY.actif]).toEqual([false, true]);
      expect([appli.TABLE.actif, site.TABLE.actif]).toEqual([true, false]);
      expect(refusCommande(site, OrderType.PICKUP, PaymentMethod.ONLINE, OrderChannel.WEB)).toBe(
        "La commande à emporter n'est pas proposée pour le moment. Choisissez un autre mode de réception.",
      );
      expect(refusCommande(appli, OrderType.PICKUP, PaymentMethod.ONLINE, OrderChannel.APP)).toBeNull();
      expect(refusCommande(appli, OrderType.DELIVERY, PaymentMethod.ONLINE, OrderChannel.APP)).toContain('La livraison');
      // Le paiement, lui, reste le même réglage pour les deux canaux.
      const paiement = { ...valeurs, order_paiement_emporter: 'LES_DEUX' };
      expect(reglagesCommande(paiement, null, 'APP').PICKUP.paiement).toBe('LES_DEUX');
      expect(reglagesCommande(paiement, null, 'WEB').PICKUP.paiement).toBe('LES_DEUX');
    });

    it('coupure temporaire de la livraison : les deux canaux, quel que soit ce qui est coché', () => {
      const coupure = { disabled: true, message: 'Livraison suspendue ce soir.' };
      for (const canal of ['APP', 'WEB'] as const) {
        expect(reglagesCommande({ order_type_livraison: 'APP,WEB' }, coupure, canal).DELIVERY).toMatchObject({
          actif: false,
          message: 'Livraison suspendue ce soir.',
        });
      }
    });

    it('canal absent : l’application (appelants d’avant les cases à cocher)', () => {
      expect(reglagesCommande({ order_type_emporter: 'WEB' }).PICKUP.actif).toBe(false);
      expect(reglagesCommande({ order_type_emporter: 'APP' }).PICKUP.actif).toBe(true);
    });
  });

  describe('contrôle à la création', () => {
    const tout = reglagesCommande({
      order_type_sur_place: '1',
      order_paiement_livraison: 'LES_DEUX',
      order_paiement_emporter: 'A_LA_RECEPTION',
    });

    it('type non proposé : refus avec son message', () => {
      const r = reglagesCommande({ order_type_emporter: '0' });
      expect(refusCommande(r, OrderType.PICKUP, PaymentMethod.ONLINE)).toBe(
        "La commande à emporter n'est pas proposée pour le moment. Choisissez un autre mode de réception.",
      );
      expect(refusCommande(r, OrderType.TABLE, PaymentMethod.ONLINE)).toContain('sur place');
      expect(refusCommande(r, OrderType.DELIVERY, PaymentMethod.ONLINE)).toBeNull();
    });

    it('les deux : en ligne et à la réception passent', () => {
      expect(refusCommande(tout, OrderType.DELIVERY, PaymentMethod.ONLINE)).toBeNull();
      expect(refusCommande(tout, OrderType.DELIVERY, PaymentMethod.OFFLINE)).toBeNull();
    });

    it('en ligne seulement : à la réception refusé, un moyen absent aussi', () => {
      expect(refusCommande(tout, OrderType.TABLE, PaymentMethod.OFFLINE)).toBe(
        'Pour ce mode de réception, le paiement se fait en ligne.',
      );
      expect(refusCommande(tout, OrderType.TABLE, undefined)).toBe(
        'Pour ce mode de réception, le paiement se fait en ligne.',
      );
      expect(refusCommande(tout, OrderType.TABLE, PaymentMethod.ONLINE)).toBeNull();
    });

    it('à la réception seulement : en ligne refusé, avec le lieu du paiement', () => {
      expect(refusCommande(tout, OrderType.PICKUP, PaymentMethod.ONLINE, OrderChannel.APP)).toBe(
        "Pour ce mode de réception, le paiement se fait au restaurant. Mettez l'application à jour si ce choix n'apparaît pas.",
      );
      // Le site n'a pas d'application à mettre à jour.
      expect(refusCommande(tout, OrderType.PICKUP, PaymentMethod.ONLINE, OrderChannel.WEB)).toBe(
        'Pour ce mode de réception, le paiement se fait au restaurant.',
      );
      expect(refusCommande(tout, OrderType.PICKUP, PaymentMethod.OFFLINE)).toBeNull();
      const livraison = reglagesCommande({ order_paiement_livraison: 'A_LA_RECEPTION' });
      expect(refusCommande(livraison, OrderType.DELIVERY, PaymentMethod.ONLINE)).toContain('à la livraison');
    });
  });

  describe('commande à payer à la réception : directe ou après confirmation', () => {
    it('lecture du réglage ; absent ou illisible : après confirmation (ce que le site faisait)', () => {
      expect(lireModeReception('DIRECTE')).toBe('DIRECTE');
      expect(lireModeReception(' directe ')).toBe('DIRECTE');
      expect(lireModeReception('APRES_CONFIRMATION')).toBe('APRES_CONFIRMATION');
      expect(lireModeReception(null)).toBe('APRES_CONFIRMATION');
      expect(lireModeReception('')).toBe('APRES_CONFIRMATION');
      expect(lireModeReception('tout de suite')).toBe('APRES_CONFIRMATION');
      expect(modeReception({ order_paiement_reception: 'DIRECTE' })).toBe('DIRECTE');
      expect(modeReception({})).toBe('APRES_CONFIRMATION');
    });

    it('directe : la commande à payer à la réception part au restaurant', () => {
      expect(parcoursCommande(PaymentMethod.OFFLINE, 'DIRECTE')).toEqual({ directe: true, aConfirmer: false });
      // Moyen absent : à la réception, comme le reste de createv2.
      expect(parcoursCommande(undefined, 'DIRECTE')).toEqual({ directe: true, aConfirmer: false });
    });

    it('après confirmation : elle attend l’appel du centre d’appels', () => {
      expect(parcoursCommande(PaymentMethod.OFFLINE, 'APRES_CONFIRMATION')).toEqual({ directe: false, aConfirmer: true });
    });

    it('en ligne : ni l’un ni l’autre, elle attend son paiement comme avant', () => {
      expect(parcoursCommande(PaymentMethod.ONLINE, 'DIRECTE')).toEqual({ directe: false, aConfirmer: false });
      expect(parcoursCommande(PaymentMethod.ONLINE, 'APRES_CONFIRMATION')).toEqual({ directe: false, aConfirmer: false });
    });
  });
});
