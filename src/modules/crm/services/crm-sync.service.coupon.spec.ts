/**
 * COUPONS DU CRM ET COMMANDE MODIFIÉE (02/10).
 *
 * « Modifier la commande » retire ou remplace désormais le coupon d'une
 * commande. Le code promo est rendu au client côté commandes ; le CRM doit
 * suivre : le coupon de la fiche redevient disponible (`used_at`, `order_id`,
 * `order_amount` effacés) et la fiche est rejugée. `rattacherCoupon` testé en
 * isolation, Prisma simulé sur les deux tables qu'il touche.
 */
import { EntityStatus } from '@prisma/client';
import { CrmSyncService } from './crm-sync.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';

type Ligne = Record<string, any>;

const commande = (surcharge: Ligne = {}): Ligne => ({
  id: COMMANDE,
  reference: 'CMD-1',
  created_at: new Date('2026-10-01T10:00:00.000Z'),
  amount: 6400,
  code_promo: 'BV-AAAA',
  restaurant_id: 'r1',
  entity_status: EntityStatus.ACTIVE,
  payment_method: 'OFFLINE',
  paied: true,
  ...surcharge,
});

const coupon = (surcharge: Ligne = {}): Ligne => ({
  id: 'k1',
  contact_id: 'x1',
  code: 'BV-AAAA',
  used_at: new Date('2026-10-01T10:00:00.000Z'),
  order_id: COMMANDE,
  order_amount: 6400,
  ...surcharge,
});

const memeCode = (a: unknown, b: unknown) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

/** Filtre `where` de `crmCoupon` tel que `rattacherCoupon` l'écrit. */
function filtre(k: Ligne, where: Ligne): boolean {
  if (where.order_id !== undefined && k.order_id !== where.order_id) return false;
  if (where.NOT?.code && memeCode(k.code, where.NOT.code.equals)) return false;
  if (where.code && !memeCode(k.code, where.code.equals)) return false;
  if (where.OR && !where.OR.some((c: Ligne) => filtre(k, c))) return false;
  if (where.used_at === null && k.used_at !== null) return false;
  if (where.id?.in && !where.id.in.includes(k.id)) return false;
  if (where.id && typeof where.id === 'string' && k.id !== where.id) return false;
  return true;
}

function monter(enBase: Ligne | null, coupons: Ligne[]) {
  const prisma = {
    order: {
      findUnique: jest.fn(async () => (enBase ? { entity_status: enBase.entity_status, code_promo: enBase.code_promo } : null)),
      findFirst: jest.fn(async () => (enBase && enBase.entity_status !== EntityStatus.DELETED ? { ...enBase } : null)),
    },
    crmCoupon: {
      findMany: jest.fn(async ({ where }: { where: Ligne }) => coupons.filter((k) => filtre(k, where)).map((k) => ({ ...k }))),
      updateMany: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
        const touches = coupons.filter((k) => filtre(k, where));
        touches.forEach((k) => Object.assign(k, data));
        return { count: touches.length };
      }),
    },
  };
  const service = Object.create(CrmSyncService.prototype) as CrmSyncService;
  const synchroniserContact = jest.fn(async (_contactId: string) => undefined);
  Object.assign(service, { prisma, synchroniserContact });
  return { service, prisma, coupons, synchroniserContact };
}

describe('CrmSyncService.rattacherCoupon : coupon retiré ou remplacé en modification', () => {
  it('la commande ne porte plus de code : son coupon est rendu, la fiche rejugée', async () => {
    const m = monter(commande({ code_promo: null }), [coupon()]);

    await m.service.rattacherCoupon(COMMANDE);

    expect(m.coupons[0]).toEqual(expect.objectContaining({ used_at: null, order_id: null, order_amount: null }));
    expect(m.synchroniserContact).toHaveBeenCalledWith('x1');
    // Plus de code à rattacher : pas de lecture de la commande effective.
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('le code a été remplacé : l’ancien coupon est rendu, le nouveau rattaché, les deux fiches rejugées', async () => {
    const m = monter(commande({ code_promo: 'BV-BBBB' }), [
      coupon(),
      coupon({ id: 'k2', contact_id: 'x2', code: 'bv-bbbb', used_at: null, order_id: null, order_amount: null }),
    ]);

    await m.service.rattacherCoupon(COMMANDE);

    expect(m.coupons[0]).toEqual(expect.objectContaining({ code: 'BV-AAAA', used_at: null, order_id: null, order_amount: null }));
    expect(m.coupons[1]).toEqual(
      expect.objectContaining({ code: 'bv-bbbb', used_at: new Date('2026-10-01T10:00:00.000Z'), order_id: COMMANDE, order_amount: 6400 }),
    );
    expect(m.synchroniserContact.mock.calls.map((c) => c[0])).toEqual(['x1', 'x2']);
  });

  it('le code est le même (majuscules indifférentes) : rien n’est rendu', async () => {
    const m = monter(commande({ code_promo: 'bv-aaaa ' }), [coupon()]);
    await m.service.rattacherCoupon(COMMANDE);
    expect(m.coupons[0]).toEqual(expect.objectContaining({ used_at: expect.any(Date), order_id: COMMANDE }));
    expect(m.prisma.crmCoupon.updateMany).not.toHaveBeenCalled();
  });

  it('commande supprimée : tous ses coupons sont rendus, quel que soit le code (comportement conservé)', async () => {
    const m = monter(commande({ entity_status: EntityStatus.DELETED }), [coupon(), coupon({ id: 'k2', contact_id: 'x2', code: 'BV-BBBB' })]);

    await m.service.rattacherCoupon(COMMANDE);

    expect(m.coupons.every((k) => k.used_at === null && k.order_id === null)).toBe(true);
    expect(m.synchroniserContact.mock.calls.map((c) => c[0])).toEqual(['x1', 'x2']);
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('commande vivante mais pas effective (en ligne, impayée) : l’ancien coupon est rendu, le nouveau attend le paiement', async () => {
    const m = monter(commande({ code_promo: 'BV-BBBB', payment_method: 'ONLINE', paied: false }), [
      coupon(),
      coupon({ id: 'k2', contact_id: 'x2', code: 'BV-BBBB', used_at: null, order_id: null, order_amount: null }),
    ]);
    // Pas effective : `findFirst` avec `commandeEffective()` ne la trouve pas.
    m.prisma.order.findFirst.mockResolvedValue(null);

    await m.service.rattacherCoupon(COMMANDE);

    expect(m.coupons[0]).toEqual(expect.objectContaining({ used_at: null, order_id: null }));
    expect(m.coupons[1]).toEqual(expect.objectContaining({ used_at: null, order_id: null }));
  });

  it('commande inconnue : rien', async () => {
    const m = monter(null, [coupon()]);
    await m.service.rattacherCoupon(COMMANDE);
    expect(m.prisma.crmCoupon.findMany).not.toHaveBeenCalled();
    expect(m.coupons[0].order_id).toBe(COMMANDE);
  });
});
