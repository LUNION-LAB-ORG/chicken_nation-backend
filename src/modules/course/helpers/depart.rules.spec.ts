import { DeliveryStatut, OrderStatus } from '@prisma/client';

import {
  ajoutPasEncoreRemis,
  LivraisonAuDepart,
  livraisonADemarrerAuDepart,
  motifFermetureALaValidation,
  sortiDuRestaurant,
} from './depart.rules';
import { REGLAGES_PLANIFICATION_DEFAUT } from './planification.rules';

const RESTAURANT = { lat: 5.286, lng: -3.9737 };
const KM_LNG = 1 / 110.8;
const aLEst = (metres: number) => ({ lat: RESTAURANT.lat, lng: RESTAURANT.lng + (metres / 1000) * KM_LNG });
const RETRAIT = new Date('2026-10-23T12:00:00.000Z');
const apres = (s: number) => new Date(RETRAIT.getTime() + s * 1000);

describe('sortiDuRestaurant : départ déduit de la position', () => {
  const base = { restaurant: RESTAURANT, picked_up_at: RETRAIT, departRayonM: 250 };

  it('position reçue après le retrait, à plus de 250 m : parti', () => {
    expect(sortiDuRestaurant({ ...base, position: aLEst(300), position_at: apres(30) })).toBe(true);
  });

  it('encore dans le rayon : pas parti', () => {
    expect(sortiDuRestaurant({ ...base, position: aLEst(200), position_at: apres(30) })).toBe(false);
  });

  it('position d’avant le retrait (il arrivait) : rien à conclure', () => {
    expect(sortiDuRestaurant({ ...base, position: aLEst(2000), position_at: apres(-30) })).toBe(false);
    expect(sortiDuRestaurant({ ...base, position: aLEst(2000), position_at: RETRAIT })).toBe(false);
  });

  it('sans position, sans coordonnées du restaurant ou sans retrait : rien à conclure', () => {
    expect(sortiDuRestaurant({ ...base, position: null, position_at: apres(30) })).toBe(false);
    expect(sortiDuRestaurant({ ...base, restaurant: null, position: aLEst(900), position_at: apres(30) })).toBe(false);
    expect(sortiDuRestaurant({ ...base, picked_up_at: null, position: aLEst(900), position_at: apres(30) })).toBe(false);
  });

  it('rayon réglé : 400 m', () => {
    expect(sortiDuRestaurant({ ...base, departRayonM: 400, position: aLEst(300), position_at: apres(30) })).toBe(false);
  });
});

const livraison = (
  id: string,
  sequence_order: number,
  statut: DeliveryStatut,
  status: OrderStatus,
  ajoutee_apres_retrait = false,
): LivraisonAuDepart => ({ id, sequence_order, statut, ajoutee_apres_retrait, order: { status } });

describe('ajoutPasEncoreRemis', () => {
  it('ajoutée après le retrait, prête, pas démarrée : pas remise', () => {
    expect(ajoutPasEncoreRemis(livraison('c', 2, DeliveryStatut.PENDING, OrderStatus.READY, true))).toBe(true);
  });

  it('remise (récupérée), ou commande d’origine encore prête (bouton de la caisse commande par commande) : non', () => {
    expect(ajoutPasEncoreRemis(livraison('c', 2, DeliveryStatut.PENDING, OrderStatus.PICKED_UP, true))).toBe(false);
    expect(ajoutPasEncoreRemis(livraison('b', 2, DeliveryStatut.PENDING, OrderStatus.READY, false))).toBe(false);
  });
});

describe('livraisonADemarrerAuDepart : la première livraison démarrée par le serveur au départ', () => {
  const tournee = [
    livraison('c', 1, DeliveryStatut.PENDING, OrderStatus.READY, true), // ajoutée, pas remise
    livraison('a', 2, DeliveryStatut.PENDING, OrderStatus.PICKED_UP),
    livraison('b', 3, DeliveryStatut.PENDING, OrderStatus.PICKED_UP),
  ];

  it('nouvelle appli : la première de la tournée dont la commande est remise', () => {
    expect(livraisonADemarrerAuDepart(tournee, 3)).toBe('a');
    expect(livraisonADemarrerAuDepart(tournee, 4)).toBe('a');
  });

  it('ancienne appli (protocole 2, sans en-tête, inconnu) : jamais, elle démarre la sienne à la validation', () => {
    expect(livraisonADemarrerAuDepart(tournee, 2)).toBeNull();
    expect(livraisonADemarrerAuDepart(tournee, 1)).toBeNull();
    expect(livraisonADemarrerAuDepart(tournee, null)).toBeNull();
  });

  it('une livraison déjà commencée : rien', () => {
    const enRoute = [livraison('a', 1, DeliveryStatut.IN_ROUTE, OrderStatus.PICKED_UP), livraison('b', 2, DeliveryStatut.PENDING, OrderStatus.PICKED_UP)];
    expect(livraisonADemarrerAuDepart(enRoute, 3)).toBeNull();
  });

  it('livraisons annulées ignorées ; rien de remis : rien', () => {
    const annulee = [livraison('x', 1, DeliveryStatut.CANCELLED, OrderStatus.PICKED_UP), livraison('a', 2, DeliveryStatut.PENDING, OrderStatus.PICKED_UP)];
    expect(livraisonADemarrerAuDepart(annulee, 3)).toBe('a');
    expect(livraisonADemarrerAuDepart([livraison('c', 1, DeliveryStatut.PENDING, OrderStatus.READY, true)], 3)).toBeNull();
  });
});

describe('motifFermetureALaValidation : fenêtre fermée d’office à la validation', () => {
  const reglages = REGLAGES_PLANIFICATION_DEFAUT;
  const avec = (protocole_appli: number | null, autre: Partial<Parameters<typeof motifFermetureALaValidation>[0]> = {}) =>
    motifFermetureALaValidation({ version: 'v2', deliverer_id: 'd1', protocole_appli, reglages, ...autre });

  it('nouvelle appli en v2, réglage actif : ouverte', () => {
    expect(avec(3)).toBeNull();
  });

  it('sans en-tête (1), protocole 2, inconnu : fermée (ANCIENNE_APPLI)', () => {
    expect(avec(1)).toBe('ANCIENNE_APPLI');
    expect(avec(2)).toBe('ANCIENNE_APPLI');
    expect(avec(null)).toBe('ANCIENNE_APPLI');
  });

  it('v1, course sans livreur interne, réglage coupé ou fenêtre à 0 : fermée', () => {
    expect(avec(3, { version: 'v1' })).toBe('REPLI_V1');
    expect(avec(3, { deliverer_id: null })).toBe('SANS_LIVREUR');
    expect(avec(3, { reglages: { ...reglages, ajoutApresRetrait: false } })).toBe('AJOUT_COUPE');
    expect(avec(3, { reglages: { ...reglages, ajoutApresRetraitMaxS: 0 } })).toBe('AJOUT_COUPE');
  });
});
