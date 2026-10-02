/**
 * Encaissement depuis la caisse et le back office (POST /paiements/add).
 *
 * Ces règles ferment une faille : un compte du restaurant A encaissait, donc
 * marquait payée et terminait, la commande du restaurant B. Si l'un de ces
 * tests casse, ne l'adaptez pas sans relire la faille.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityStatus, OrderStatus, User, UserRole, UserType } from '@prisma/client';
import {
  encaisseAvant,
  estPaiementEnDouble,
  etatApresEncaissement,
  extraireEncaissement,
  PAYMENT_AMOUNT_TOLERANCE,
  verifierCommandeEncaissable,
} from './encaissement.helper';

const COMMANDE_A = '11111111-1111-4111-8111-111111111111';
const COMMANDE_B = '22222222-2222-4222-8222-222222222222';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const compte = (type: UserType, role: UserRole, restaurant_id: string | null) =>
  ({ id: 'u1', type, role, restaurant_id }) as unknown as User;

const caissierA = compte(UserType.RESTAURANT, UserRole.CAISSIER, RESTAURANT_A);
const administrateur = compte(UserType.BACKOFFICE, UserRole.ADMIN, null);

const commande = (surcharge: Partial<{ restaurant_id: string | null; status: OrderStatus; entity_status: EntityStatus }> = {}) => ({
  id: COMMANDE_A,
  restaurant_id: RESTAURANT_A,
  status: OrderStatus.READY,
  entity_status: EntityStatus.ACTIVE,
  ...surcharge,
});

describe('extraireEncaissement', () => {
  it('rend la commande et les lignes de la caisse', () => {
    const r = extraireEncaissement([
      { amount: 3000, order_id: COMMANDE_A },
      { amount: 2000, order_id: COMMANDE_A },
    ]);
    expect(r.orderId).toBe(COMMANDE_A);
    expect(r.lignes.map((l) => l.amount)).toEqual([3000, 2000]);
  });

  it('ignore les lignes à zéro sans erreur (la caisse en envoie)', () => {
    const r = extraireEncaissement([
      { amount: 5000, order_id: COMMANDE_A },
      { amount: 0, order_id: COMMANDE_A },
    ]);
    expect(r.lignes).toHaveLength(1);
  });

  it('accepte une commande à zéro franc réglée par une ligne à zéro', () => {
    const r = extraireEncaissement([{ amount: 0, order_id: COMMANDE_A }]);
    expect(r.orderId).toBe(COMMANDE_A);
    expect(r.lignes).toHaveLength(0);
  });

  it('refuse une ligne sans commande : elle créait un paiement orphelin', () => {
    expect(() =>
      extraireEncaissement([{ amount: 5000, order_id: COMMANDE_A }, { amount: 1000 }]),
    ).toThrow(BadRequestException);
    expect(() => extraireEncaissement([{ amount: 5000 }])).toThrow(BadRequestException);
  });

  it('refuse deux commandes dans le même encaissement', () => {
    expect(() =>
      extraireEncaissement([
        { amount: 5000, order_id: COMMANDE_A },
        { amount: 5000, order_id: COMMANDE_B },
      ]),
    ).toThrow(BadRequestException);
  });

  it('refuse un encaissement vide', () => {
    expect(() => extraireEncaissement([])).toThrow(BadRequestException);
  });
});

describe('verifierCommandeEncaissable', () => {
  it('laisse un caissier encaisser une commande de SON restaurant', () => {
    expect(verifierCommandeEncaissable(commande(), caissierA).id).toBe(COMMANDE_A);
  });

  it('interdit à un compte de restaurant la commande d’un autre restaurant', () => {
    expect(() =>
      verifierCommandeEncaissable(commande({ restaurant_id: RESTAURANT_B }), caissierA),
    ).toThrow(ForbiddenException);
  });

  it('interdit tout à un compte de restaurant sans restaurant rattaché', () => {
    const orphelin = compte(UserType.RESTAURANT, UserRole.CAISSIER, null);
    expect(() => verifierCommandeEncaissable(commande(), orphelin)).toThrow(ForbiddenException);
  });

  it('laisse le back office encaisser dans tout le réseau', () => {
    expect(
      verifierCommandeEncaissable(commande({ restaurant_id: RESTAURANT_B }), administrateur).id,
    ).toBe(COMMANDE_A);
  });

  it('contrôle le restaurant AVANT le statut : rien n’est appris d’une commande étrangère', () => {
    expect(() =>
      verifierCommandeEncaissable(
        commande({ restaurant_id: RESTAURANT_B, status: OrderStatus.CANCELLED }),
        caissierA,
      ),
    ).toThrow(ForbiddenException);
  });

  it('refuse une commande annulée', () => {
    expect(() =>
      verifierCommandeEncaissable(commande({ status: OrderStatus.CANCELLED }), caissierA),
    ).toThrow(BadRequestException);
  });

  it('répond « introuvable » pour une commande absente ou supprimée', () => {
    expect(() => verifierCommandeEncaissable(null, caissierA)).toThrow(NotFoundException);
    expect(() =>
      verifierCommandeEncaissable(commande({ entity_status: EntityStatus.DELETED }), administrateur),
    ).toThrow(NotFoundException);
  });
});

describe('etatApresEncaissement', () => {
  it('solde et termine une commande remise au client et entièrement réglée', () => {
    expect(etatApresEncaissement(8000, 8000, OrderStatus.COLLECTED)).toEqual({
      soldee: true,
      aTerminer: true,
    });
  });

  it('solde sans terminer une commande pas encore remise', () => {
    expect(etatApresEncaissement(8000, 8000, OrderStatus.READY)).toEqual({
      soldee: true,
      aTerminer: false,
    });
  });

  it('absorbe l’arrondi de taxe jusqu’à la tolérance, pas au delà', () => {
    expect(etatApresEncaissement(8000, 8000 - PAYMENT_AMOUNT_TOLERANCE, OrderStatus.READY).soldee).toBe(true);
    expect(etatApresEncaissement(8000, 8000 - PAYMENT_AMOUNT_TOLERANCE - 1, OrderStatus.READY).soldee).toBe(false);
  });

  it('ne rend pas payée une commande réglée à moitié, et ne la termine pas', () => {
    expect(etatApresEncaissement(8000, 4000, OrderStatus.COLLECTED)).toEqual({
      soldee: false,
      aTerminer: false,
    });
  });
});

describe('encaisseAvant (paiement reçu deux fois)', () => {
  const t = (minute: number) => new Date(`2026-10-02T10:${String(minute).padStart(2, '0')}:00.000Z`);
  const premier = { id: 'p1', reference: 'kk-1', amount: 10000, created_at: t(0) };
  const second = { id: 'p2', reference: 'kk-2', amount: 10000, created_at: t(5) };

  it('compte les paiements enregistrés avant celui-ci', () => {
    expect(encaisseAvant([premier, second], second)).toBe(10000);
  });

  it("ne voit rien avant le premier, même une fois le second enregistré : seul le second est à rembourser", () => {
    expect(encaisseAvant([premier, second], premier)).toBe(0);
  });

  it("ignore le paiement lui-même et un second enregistrement de la même transaction", () => {
    const memeTransaction = { id: 'p1-bis', reference: 'kk-1', amount: 10000, created_at: t(0) };
    expect(encaisseAvant([premier, memeTransaction], { ...premier, created_at: t(1) })).toBe(0);
  });

  it("deux transactions à la même milliseconde : une seule voit l'autre avant elle", () => {
    const a = { ...premier, id: 'a', reference: 'kk-a', created_at: t(3) };
    const b = { ...premier, id: 'b', reference: 'kk-b', created_at: t(3) };
    expect(encaisseAvant([a, b], a)).toBe(0);
    expect(encaisseAvant([a, b], b)).toBe(10000);
  });

  it('compte le montant sans la commission KKiaPay', () => {
    // `amount` seul : la commission (dans `total`) n'est pas versée pour la commande.
    expect(encaisseAvant([{ ...premier, amount: 9000 }], second)).toBe(9000);
  });

  it('ne compte rien quand une date manque', () => {
    expect(encaisseAvant([{ ...premier, created_at: null }], second)).toBe(0);
    expect(encaisseAvant([premier], { ...second, created_at: null })).toBe(0);
  });
});

describe('estPaiementEnDouble', () => {
  it('oui quand les paiements précédents couvraient déjà la commande, à la tolérance près', () => {
    expect(estPaiementEnDouble(10000, 10000)).toBe(true);
    expect(estPaiementEnDouble(10000, 10000 - PAYMENT_AMOUNT_TOLERANCE)).toBe(true);
  });

  it("non quand ce paiement complète un encaissement partiel", () => {
    expect(estPaiementEnDouble(10000, 10000 - PAYMENT_AMOUNT_TOLERANCE - 1)).toBe(false);
    expect(estPaiementEnDouble(10000, 4000)).toBe(false);
  });

  it("non pour le premier paiement, même d'une commande à zéro franc", () => {
    expect(estPaiementEnDouble(10000, 0)).toBe(false);
    expect(estPaiementEnDouble(0, 0)).toBe(false);
  });

  it('non sans montant de commande', () => {
    expect(estPaiementEnDouble(null, 10000)).toBe(false);
    expect(estPaiementEnDouble(undefined, 10000)).toBe(false);
  });
});
