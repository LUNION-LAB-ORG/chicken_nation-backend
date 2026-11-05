/**
 * Offres de livraison : étudiants, menus et catégories (05/11).
 *
 *  - étudiant = Carte de la Nation ACTIVE et étudiante, pas le profil déclaré à
 *    l'adhésion ni une carte suspendue ;
 *  - il suffit de remplir l'une des cases de clients cochées ;
 *  - il suffit d'un plat du panier parmi les menus ou catégories choisis ;
 *  - l'aperçu ne révèle rien à un invité sur le client qu'il indique.
 */
import { DeliveryOfferType, LoyaltyLevel, NationCardStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { FraisLivraisonDto } from 'src/modules/order/dto/frais-livrasion.dto';
import { clientDeLApercu } from 'src/modules/order/helpers/client-apercu-frais.rules';

import { DeliveryOfferService } from './delivery-offer.service';

const MENU = '11111111-1111-4111-8111-111111111111';
const AUTRE_MENU = '22222222-2222-4222-8222-222222222222';
const CATEGORIE = '33333333-3333-4333-8333-333333333333';
const AUTRE_CATEGORIE = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';

const offre = (surcharge: Record<string, unknown> = {}) => ({
  id: 'offre-1',
  name: 'Offre',
  type: DeliveryOfferType.FREE_DELIVERY,
  value: 0,
  price_tiers: null,
  min_order_amount: 0,
  channel: 'BOTH',
  restaurant_ids: [],
  target_standard: false,
  target_premium: false,
  target_gold: false,
  target_etudiant: false,
  dish_ids: [],
  category_ids: [],
  days_of_week: [],
  time_start: null,
  time_end: null,
  max_usage: null,
  max_usage_per_user: 0,
  usage_count: 0,
  ...surcharge,
});

function monter(
  offres: Record<string, unknown>[],
  base: { carte?: boolean; niveau?: LoyaltyLevel | null; plats?: { id: string; category_id: string }[] } = {},
) {
  const prisma = {
    deliveryOffer: { findMany: jest.fn(async () => offres) },
    deliveryOfferUsage: { count: jest.fn(async () => 0) },
    customer: { findUnique: jest.fn(async () => ({ loyalty_level: base.niveau ?? null })) },
    nationCard: { findFirst: jest.fn(async () => (base.carte ? { id: 'carte-1' } : null)) },
    dish: { findMany: jest.fn(async () => base.plats ?? []) },
  };
  return { prisma, service: new DeliveryOfferService(prisma as never) };
}

const contexte = (surcharge: Record<string, unknown> = {}) => ({
  baseFee: 1500,
  channel: 'APP' as const,
  orderAmount: 5000,
  customerId: CLIENT,
  ...surcharge,
});

describe('offre réservée aux étudiants', () => {
  const pourEtudiants = offre({ target_etudiant: true });

  it('client avec une carte étudiante active : offre appliquée', async () => {
    const t = monter([pourEtudiants], { carte: true });

    const r = await t.service.findApplicableOffer(contexte());

    expect(r?.newFee).toBe(0);
    expect(t.prisma.nationCard.findFirst).toHaveBeenCalledWith({
      where: { customer_id: CLIENT, is_student: true, status: NationCardStatus.ACTIVE },
      select: { id: true },
    });
  });

  it('sans carte étudiante active : pas d’offre', async () => {
    const t = monter([pourEtudiants], { carte: false });
    expect(await t.service.findApplicableOffer(contexte())).toBeNull();
  });

  it('invité : pas d’offre, sans lecture de carte', async () => {
    const t = monter([pourEtudiants], { carte: true });

    expect(await t.service.findApplicableOffer(contexte({ customerId: null }))).toBeNull();
    expect(t.prisma.nationCard.findFirst).not.toHaveBeenCalled();
  });

  it('étudiant et VIP cochés : l’un ou l’autre suffit', async () => {
    const lesDeux = offre({ target_etudiant: true, target_premium: true });

    const vip = monter([lesDeux], { niveau: LoyaltyLevel.VIP, carte: false });
    expect((await vip.service.findApplicableOffer(contexte()))?.newFee).toBe(0);

    const etudiant = monter([lesDeux], { niveau: LoyaltyLevel.STANDARD, carte: true });
    expect((await etudiant.service.findApplicableOffer(contexte()))?.newFee).toBe(0);

    const niLUnNiLAutre = monter([lesDeux], { niveau: LoyaltyLevel.STANDARD, carte: false });
    expect(await niLUnNiLAutre.service.findApplicableOffer(contexte())).toBeNull();
  });

  it('niveau seul coché : un étudiant d’un autre niveau n’y a pas droit', async () => {
    const t = monter([offre({ target_premium: true })], { niveau: LoyaltyLevel.STANDARD, carte: true });

    expect(await t.service.findApplicableOffer(contexte())).toBeNull();
    expect(t.prisma.nationCard.findFirst).not.toHaveBeenCalled();
  });

  it('aucune case cochée : tous les clients, sans lire la carte', async () => {
    const t = monter([offre()]);

    expect((await t.service.findApplicableOffer(contexte()))?.newFee).toBe(0);
    expect(t.prisma.nationCard.findFirst).not.toHaveBeenCalled();
  });
});

describe('offre limitée à des menus ou des catégories', () => {
  const plats = [
    { id: MENU, category_id: CATEGORIE },
    { id: AUTRE_MENU, category_id: AUTRE_CATEGORIE },
  ];

  it('un seul menu choisi dans le panier suffit', async () => {
    const t = monter([offre({ dish_ids: [MENU] })], { plats });

    const r = await t.service.findApplicableOffer(contexte({ dishIds: [MENU, AUTRE_MENU] }));

    expect(r?.newFee).toBe(0);
  });

  it('un plat d’une catégorie choisie suffit', async () => {
    const t = monter([offre({ category_ids: [CATEGORIE] })], { plats: [plats[0]] });

    const r = await t.service.findApplicableOffer(contexte({ dishIds: [MENU] }));

    expect(r?.newFee).toBe(0);
  });

  it('aucun plat concerné : pas d’offre', async () => {
    const t = monter([offre({ dish_ids: [MENU], category_ids: [CATEGORIE] })], { plats: [plats[1]] });

    expect(await t.service.findApplicableOffer(contexte({ dishIds: [AUTRE_MENU] }))).toBeNull();
  });

  it('panier inconnu (ancienne appli) : l’offre ne s’applique pas', async () => {
    const t = monter([offre({ dish_ids: [MENU] })], { plats });

    expect(await t.service.findApplicableOffer(contexte())).toBeNull();
    expect(t.prisma.dish.findMany).not.toHaveBeenCalled();
  });

  it('tout le menu : offre appliquée sans lire les plats', async () => {
    const t = monter([offre()], { plats });

    expect((await t.service.findApplicableOffer(contexte({ dishIds: [MENU] })))?.newFee).toBe(0);
    expect(t.prisma.dish.findMany).not.toHaveBeenCalled();
  });

  it('plusieurs offres limitées : les plats ne sont lus qu’une fois', async () => {
    const t = monter([offre({ dish_ids: [MENU] }), offre({ id: 'offre-2', category_ids: [CATEGORIE] })], { plats });

    await t.service.findApplicableOffer(contexte({ dishIds: [MENU] }));

    expect(t.prisma.dish.findMany).toHaveBeenCalledTimes(1);
  });

  it('étudiant et menu demandés ensemble : il faut les deux', async () => {
    const lesDeux = offre({ target_etudiant: true, dish_ids: [MENU] });

    const sansMenu = monter([lesDeux], { carte: true, plats: [plats[1]] });
    expect(await sansMenu.service.findApplicableOffer(contexte({ dishIds: [AUTRE_MENU] }))).toBeNull();

    const sansCarte = monter([lesDeux], { carte: false, plats: [plats[0]] });
    expect(await sansCarte.service.findApplicableOffer(contexte({ dishIds: [MENU] }))).toBeNull();

    const lesDeuxOk = monter([lesDeux], { carte: true, plats: [plats[0]] });
    expect((await lesDeuxOk.service.findApplicableOffer(contexte({ dishIds: [MENU] })))?.newFee).toBe(0);
  });
});

describe('aperçu des frais : client et panier', () => {
  it('client connecté : lui-même, quel que soit le paramètre', () => {
    expect(clientDeLApercu({ id: CLIENT }, 'autre-client')).toBe(CLIENT);
  });

  it('personnel : le client de la commande en cours de saisie, ou personne', () => {
    expect(clientDeLApercu({ id: 'agent-1', role: 'CALL_CENTER' }, CLIENT)).toBe(CLIENT);
    expect(clientDeLApercu({ id: 'agent-1', role: 'CALL_CENTER' })).toBeNull();
  });

  it('invité : le paramètre est ignoré', () => {
    expect(clientDeLApercu(undefined, CLIENT)).toBeNull();
  });

  const lire = (valeurs: Record<string, unknown>) => {
    const dto = plainToInstance(FraisLivraisonDto, { lat: '5.3', long: '-4', ...valeurs });
    return { dto, erreurs: validateSync(dto) };
  };

  it('plats reçus séparés par des virgules', () => {
    const { dto, erreurs } = lire({ dish_ids: `${MENU},${AUTRE_MENU}` });

    expect(erreurs).toEqual([]);
    expect(dto.dish_ids).toEqual([MENU, AUTRE_MENU]);
  });

  it('sans plats : valide, comme une appli pas encore à jour', () => {
    const { dto, erreurs } = lire({});

    expect(erreurs).toEqual([]);
    expect(dto.dish_ids).toBeUndefined();
  });

  it('identifiant de plat invalide : refusé', () => {
    expect(lire({ dish_ids: 'pas-un-plat' }).erreurs).not.toEqual([]);
  });
});
