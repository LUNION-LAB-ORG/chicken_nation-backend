import { OrderChannel, OrderType, PaymentMethod } from '@prisma/client';

import {
  CLES_REGLAGES_COMMANDE,
  cleReception,
  clePaiement,
  cleType,
  lireModeReception,
  lirePaiement,
  lirePaiementLivraisonSite,
  lireTypeActif,
  modeReception,
  parcoursCommande,
  refusCommande,
  reglagesCommande,
} from './reglages-commande.rules';

/**
 * Types de commande et paiement : un paramétrage pour l'application, un
 * paramétrage pour le site (demandes du 26/11).
 */
describe('Types de commande et paiement : un paramétrage par canal', () => {
  const appli = (valeurs: Record<string, string | null> = {}, coupure: { disabled: boolean; message: string } | null = null) =>
    reglagesCommande(valeurs, coupure, 'APP');
  const site = (valeurs: Record<string, string | null> = {}, coupure: { disabled: boolean; message: string } | null = null) =>
    reglagesCommande(valeurs, coupure, 'WEB');

  it('les clés : pour chaque canal, deux par type et le parcours', () => {
    expect([...CLES_REGLAGES_COMMANDE].sort()).toEqual(
      [
        'order_type_livraison_appli',
        'order_type_emporter_appli',
        'order_type_sur_place_appli',
        'order_paiement_livraison_appli',
        'order_paiement_emporter_appli',
        'order_paiement_sur_place_appli',
        'order_paiement_reception_appli',
        'order_type_livraison_site',
        'order_type_emporter_site',
        'order_type_sur_place_site',
        'order_paiement_livraison_site',
        'order_paiement_emporter_site',
        'order_paiement_sur_place_site',
        'order_paiement_reception_site',
      ].sort(),
    );
    expect(cleType(OrderType.DELIVERY, 'APP')).toBe('order_type_livraison_appli');
    expect(clePaiement(OrderType.PICKUP, 'WEB')).toBe('order_paiement_emporter_site');
    expect(cleReception('APP')).toBe('order_paiement_reception_appli');
    expect(cleReception('WEB')).toBe('order_paiement_reception_site');
  });

  describe('rien de réglé : ce que chaque canal faisait avant', () => {
    it('application : livraison et à emporter payés en ligne, pas de sur place, commande directe', () => {
      const r = appli();
      expect(r.DELIVERY).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
      expect(r.PICKUP).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
      expect(r.TABLE).toMatchObject({ actif: false, paiement: 'EN_LIGNE' });
      expect(r.TABLE.message).toContain("n'est pas proposée");
      // Décision du client du 26/11 au matin : l'appli envoie au restaurant.
      expect(modeReception({}, 'APP')).toBe('DIRECTE');
    });

    it('site : la livraison se paie aussi à la livraison (19/10), et la commande attend sa confirmation', () => {
      const r = site();
      expect(r.DELIVERY).toEqual({ actif: true, paiement: 'LES_DEUX', message: null });
      expect(r.PICKUP).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
      expect(r.TABLE.actif).toBe(false);
      expect(modeReception({}, 'WEB')).toBe('APRES_CONFIRMATION');
    });
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

  // `order_paiement_livraison_site` existait avant (19/10), en « 1 » / « 0 ».
  it('paiement d’une livraison sur le site : la même clé qu’avant, lue dans ses deux écritures', () => {
    // Ancienne écriture : « 1 » proposé, « 0 » coupé ; absent : proposé.
    expect(lirePaiementLivraisonSite(null)).toBe('LES_DEUX');
    expect(lirePaiementLivraisonSite('')).toBe('LES_DEUX');
    expect(lirePaiementLivraisonSite('1')).toBe('LES_DEUX');
    expect(lirePaiementLivraisonSite('oui')).toBe('LES_DEUX');
    expect(lirePaiementLivraisonSite('0')).toBe('EN_LIGNE');
    // Nouvelle écriture.
    expect(lirePaiementLivraisonSite('LES_DEUX')).toBe('LES_DEUX');
    expect(lirePaiementLivraisonSite('EN_LIGNE')).toBe('EN_LIGNE');
    expect(lirePaiementLivraisonSite('a_la_reception')).toBe('A_LA_RECEPTION');
    // Illisible : en ligne seulement.
    expect(lirePaiementLivraisonSite('peut-être')).toBe('EN_LIGNE');

    expect(site({ order_paiement_livraison_site: '0' }).DELIVERY.paiement).toBe('EN_LIGNE');
    expect(site({ order_paiement_livraison_site: '1' }).DELIVERY.paiement).toBe('LES_DEUX');
    expect(site({ order_paiement_livraison_site: 'A_LA_RECEPTION' }).DELIVERY.paiement).toBe('A_LA_RECEPTION');
    // Elle ne règle que le site, et que la livraison.
    expect(appli({ order_paiement_livraison_site: 'LES_DEUX' }).DELIVERY.paiement).toBe('EN_LIGNE');
    expect(site({ order_paiement_livraison_site: 'LES_DEUX' }).PICKUP.paiement).toBe('EN_LIGNE');
  });

  it('chaque canal se règle à part : ce qui est réglé pour l’un ne touche pas l’autre', () => {
    const valeurs = {
      // Application : pas de livraison, sur place proposé et payé au restaurant.
      order_type_livraison_appli: '0',
      order_type_sur_place_appli: '1',
      order_paiement_sur_place_appli: 'A_LA_RECEPTION',
      order_paiement_emporter_appli: 'LES_DEUX',
      // Site : pas d'à emporter, livraison en ligne seulement.
      order_type_emporter_site: '0',
      order_paiement_livraison_site: 'EN_LIGNE',
    };
    const a = appli(valeurs);
    const s = site(valeurs);
    expect([a.DELIVERY.actif, s.DELIVERY.actif]).toEqual([false, true]);
    expect([a.PICKUP.actif, s.PICKUP.actif]).toEqual([true, false]);
    expect([a.TABLE.actif, s.TABLE.actif]).toEqual([true, false]);
    expect(a.TABLE).toEqual({ actif: true, paiement: 'A_LA_RECEPTION', message: null });
    expect([a.PICKUP.paiement, s.PICKUP.paiement]).toEqual(['LES_DEUX', 'EN_LIGNE']);
    expect([a.DELIVERY.paiement, s.DELIVERY.paiement]).toEqual(['EN_LIGNE', 'EN_LIGNE']);
  });

  it('coupure temporaire de la livraison : les deux canaux, avec le message de la coupure', () => {
    const coupure = { disabled: true, message: 'Livraison suspendue ce soir.' };
    for (const r of [appli({}, coupure), site({}, coupure)]) {
      expect(r.DELIVERY).toMatchObject({ actif: false, message: 'Livraison suspendue ce soir.' });
      expect(r.PICKUP.actif).toBe(true);
    }
    // Coupure levée : la livraison revient.
    expect(appli({}, { disabled: false, message: '' }).DELIVERY.actif).toBe(true);
  });

  describe('contrôle à la création', () => {
    const tout = appli({
      order_type_sur_place_appli: '1',
      order_paiement_livraison_appli: 'LES_DEUX',
      order_paiement_emporter_appli: 'A_LA_RECEPTION',
    });

    it('type non proposé sur le canal : refus avec son message', () => {
      const r = site({ order_type_emporter_site: '0' });
      expect(refusCommande(r, OrderType.PICKUP, PaymentMethod.ONLINE, OrderChannel.WEB)).toBe(
        "La commande à emporter n'est pas proposée pour le moment. Choisissez un autre mode de réception.",
      );
      expect(refusCommande(r, OrderType.TABLE, PaymentMethod.ONLINE)).toContain('sur place');
      expect(refusCommande(r, OrderType.DELIVERY, PaymentMethod.ONLINE)).toBeNull();
      // Le même type reste proposé dans l'application.
      expect(refusCommande(appli({ order_type_emporter_site: '0' }), OrderType.PICKUP, PaymentMethod.ONLINE)).toBeNull();
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
      const livraison = appli({ order_paiement_livraison_appli: 'A_LA_RECEPTION' });
      expect(refusCommande(livraison, OrderType.DELIVERY, PaymentMethod.ONLINE)).toContain('à la livraison');
    });
  });

  describe('commande à payer à la réception : directe ou après confirmation, par canal', () => {
    it('lecture du réglage ; absent ou illisible : la valeur par défaut du canal', () => {
      expect(lireModeReception('DIRECTE', 'APRES_CONFIRMATION')).toBe('DIRECTE');
      expect(lireModeReception(' directe ', 'APRES_CONFIRMATION')).toBe('DIRECTE');
      expect(lireModeReception('APRES_CONFIRMATION', 'DIRECTE')).toBe('APRES_CONFIRMATION');
      expect(lireModeReception(null, 'APRES_CONFIRMATION')).toBe('APRES_CONFIRMATION');
      expect(lireModeReception('', 'DIRECTE')).toBe('DIRECTE');
      expect(lireModeReception('tout de suite', 'APRES_CONFIRMATION')).toBe('APRES_CONFIRMATION');
    });

    it('chaque canal a son parcours', () => {
      const valeurs = { order_paiement_reception_appli: 'APRES_CONFIRMATION', order_paiement_reception_site: 'DIRECTE' };
      expect(modeReception(valeurs, 'APP')).toBe('APRES_CONFIRMATION');
      expect(modeReception(valeurs, 'WEB')).toBe('DIRECTE');
      // Régler l'un ne touche pas l'autre.
      expect(modeReception({ order_paiement_reception_site: 'DIRECTE' }, 'APP')).toBe('DIRECTE');
      expect(modeReception({ order_paiement_reception_appli: 'APRES_CONFIRMATION' }, 'WEB')).toBe('APRES_CONFIRMATION');
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
