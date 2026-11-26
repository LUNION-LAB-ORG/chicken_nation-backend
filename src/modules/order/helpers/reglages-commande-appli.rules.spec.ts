import { OrderType, PaymentMethod } from '@prisma/client';

import {
  CLES_REGLAGES_COMMANDE_APPLI,
  lirePaiementAppli,
  lireTypeActif,
  refusCommandeAppli,
  reglagesCommandeAppli,
} from './reglages-commande-appli.rules';

/**
 * Types de commande et paiement dans l'application, réglés au back-office
 * (demande du 26/11).
 */
describe('Types de commande et paiement de l’application', () => {
  it('les six réglages, par leur clé', () => {
    expect(CLES_REGLAGES_COMMANDE_APPLI.sort()).toEqual(
      [
        'order_type_livraison_appli',
        'order_type_emporter_appli',
        'order_type_sur_place_appli',
        'order_paiement_livraison_appli',
        'order_paiement_emporter_appli',
        'order_paiement_sur_place_appli',
      ].sort(),
    );
  });

  it('rien de réglé : livraison et à emporter proposés, pas de sur place, tout en ligne (comme avant)', () => {
    const r = reglagesCommandeAppli({});
    expect(r.DELIVERY).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
    expect(r.PICKUP).toEqual({ actif: true, paiement: 'EN_LIGNE', message: null });
    expect(r.TABLE).toMatchObject({ actif: false, paiement: 'EN_LIGNE' });
    expect(r.TABLE.message).toContain("n'est pas proposée");
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

  it('lecture du paiement : les trois modes ; absent ou illisible : en ligne seulement', () => {
    expect(lirePaiementAppli('LES_DEUX')).toBe('LES_DEUX');
    expect(lirePaiementAppli(' a_la_reception ')).toBe('A_LA_RECEPTION');
    expect(lirePaiementAppli('EN_LIGNE')).toBe('EN_LIGNE');
    expect(lirePaiementAppli('especes')).toBe('EN_LIGNE');
    expect(lirePaiementAppli(null)).toBe('EN_LIGNE');
  });

  it('chaque type se règle à part', () => {
    const r = reglagesCommandeAppli({
      order_type_livraison_appli: '0',
      order_type_sur_place_appli: '1',
      order_paiement_emporter_appli: 'LES_DEUX',
      order_paiement_sur_place_appli: 'A_LA_RECEPTION',
    });
    expect(r.DELIVERY.actif).toBe(false);
    expect(r.PICKUP).toEqual({ actif: true, paiement: 'LES_DEUX', message: null });
    expect(r.TABLE).toEqual({ actif: true, paiement: 'A_LA_RECEPTION', message: null });
  });

  it('coupure temporaire de la livraison : la livraison n’est plus proposée, avec le message de la coupure', () => {
    const r = reglagesCommandeAppli({}, { disabled: true, message: 'Livraison suspendue ce soir.' });
    expect(r.DELIVERY).toEqual({ actif: false, paiement: 'EN_LIGNE', message: 'Livraison suspendue ce soir.' });
    expect(r.PICKUP.actif).toBe(true);
    // Coupure levée : la livraison revient.
    expect(reglagesCommandeAppli({}, { disabled: false, message: '' }).DELIVERY.actif).toBe(true);
  });

  describe('contrôle à la création', () => {
    const tout = reglagesCommandeAppli({
      order_type_sur_place_appli: '1',
      order_paiement_livraison_appli: 'LES_DEUX',
      order_paiement_emporter_appli: 'A_LA_RECEPTION',
    });

    it('type non proposé : refus avec son message', () => {
      const r = reglagesCommandeAppli({ order_type_emporter_appli: '0' });
      expect(refusCommandeAppli(r, OrderType.PICKUP, PaymentMethod.ONLINE)).toBe(
        "La commande à emporter n'est pas proposée pour le moment. Choisissez un autre mode de réception.",
      );
      expect(refusCommandeAppli(r, OrderType.TABLE, PaymentMethod.ONLINE)).toContain('sur place');
      expect(refusCommandeAppli(r, OrderType.DELIVERY, PaymentMethod.ONLINE)).toBeNull();
    });

    it('les deux : en ligne et à la réception passent', () => {
      expect(refusCommandeAppli(tout, OrderType.DELIVERY, PaymentMethod.ONLINE)).toBeNull();
      expect(refusCommandeAppli(tout, OrderType.DELIVERY, PaymentMethod.OFFLINE)).toBeNull();
    });

    it('en ligne seulement : à la réception refusé, un moyen absent aussi', () => {
      expect(refusCommandeAppli(tout, OrderType.TABLE, PaymentMethod.OFFLINE)).toBe(
        'Pour ce mode de réception, le paiement se fait en ligne.',
      );
      expect(refusCommandeAppli(tout, OrderType.TABLE, undefined)).toBe(
        'Pour ce mode de réception, le paiement se fait en ligne.',
      );
      expect(refusCommandeAppli(tout, OrderType.TABLE, PaymentMethod.ONLINE)).toBeNull();
    });

    it('à la réception seulement : en ligne refusé, avec le lieu du paiement', () => {
      expect(refusCommandeAppli(tout, OrderType.PICKUP, PaymentMethod.ONLINE)).toBe(
        "Pour ce mode de réception, le paiement se fait au restaurant. Mettez l'application à jour si ce choix n'apparaît pas.",
      );
      expect(refusCommandeAppli(tout, OrderType.PICKUP, PaymentMethod.OFFLINE)).toBeNull();
      const livraison = reglagesCommandeAppli({ order_paiement_livraison_appli: 'A_LA_RECEPTION' });
      expect(refusCommandeAppli(livraison, OrderType.DELIVERY, PaymentMethod.ONLINE)).toContain('à la livraison');
    });
  });
});
