/**
 * Coupon rendu quand l'annulation vient du module des courses (course annulée,
 * livraison échouée), qui écrit CANCELLED sans passer par updateStatus.
 *
 * OrderCouponService RÉEL sur la base en mémoire ; seule la lecture des
 * commandes est simulée.
 */
import { DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import {
  bon,
  CLIENT,
  codePromo,
  monterCoupons,
  PromoCodeUsageStatus,
  RESTAURANT_A,
} from '../services/order-coupon.base-simulee-spec';
import { CouponRestitutionListener } from './coupon-restitution.listener';

const COMMANDE = { id: 'commande-1', reference: 'CMD-1', customer_id: CLIENT, restaurant_id: RESTAURANT_A };

function monter(commandes: Record<string, unknown>[]) {
  const leBon = bon({ remaining_amount: 2000 });
  const promo = codePromo({ usage_count: 1 });
  const outils = monterCoupons({
    bons: [leBon],
    promos: [promo],
    redemptions: [
      { id: 'red-1', voucher_id: leBon.id, order_id: COMMANDE.id, amount: 8000, entity_status: EntityStatus.ACTIVE },
    ],
    usages: [
      {
        id: 'usage-1',
        promo_code_id: promo.id,
        customer_id: CLIENT,
        order_id: COMMANDE.id,
        discount_amount: 1600,
        status: PromoCodeUsageStatus.ACTIVE,
      },
    ],
  });
  const order = {
    findMany: jest.fn(async () => commandes),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => commandes.find((c) => c.id === where.id) ?? null),
  };
  const prisma = { ...outils.prisma, order };
  const listener = new CouponRestitutionListener(prisma as never, outils.service);
  (listener as unknown as { logger: unknown }).logger = { error: jest.fn(), warn: jest.fn() };
  return { ...outils, listener, order };
}

describe('CouponRestitutionListener', () => {
  it('écoute les deux événements du module des courses', () => {
    const noms = (methode: (...args: never[]) => unknown) =>
      JSON.stringify(Reflect.getMetadata('EVENT_LISTENER_METADATA', methode));
    expect(noms(CouponRestitutionListener.prototype.apresCourseAnnulee)).toContain(CourseChannels.COURSE_CANCELLED);
    expect(noms(CouponRestitutionListener.prototype.apresLivraisonEchouee)).toContain(
      CourseChannels.DELIVERY_STATUT_CHANGED,
    );
  });

  it("course annulée : rend le bon et le code promo des commandes annulées, et le journal dit d'où vient l'annulation", async () => {
    const outils = monter([{ ...COMMANDE }]);
    await outils.listener.apresCourseAnnulee({
      course: { id: 'course-1' },
      cancelled_by: 'system',
      reason: 'Annulation automatique',
    } as never);

    expect(outils.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: OrderStatus.CANCELLED, delivery: { course_id: 'course-1' } },
      }),
    );
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(0);
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_RESTITUE',
        actor_id: null,
        method: 'PATCH',
        path: '/courses/course-1/cancel',
        // Séparateur des milliers : espace fine insécable (toLocaleString fr-FR).
        summary: expect.stringMatching(
          /^Bon CN7K2XQ9 recrédité de 8\s000 F : commande CMD-1 annulée \(course annulée automatiquement\)$/,
        ),
      }),
    );
    expect(outils.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'CREDIT', montant: 8000, customerId: CLIENT }),
    );
  });

  it('livraison échouée : rend le coupon de la commande annulée', async () => {
    const outils = monter([{ ...COMMANDE, status: OrderStatus.CANCELLED }]);
    await outils.listener.apresLivraisonEchouee({
      delivery: { id: 'livraison-1', order_id: COMMANDE.id },
      new_statut: DeliveryStatut.FAILED,
    } as never);

    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/courses/deliverer/deliveries/livraison-1/fail',
        summary: expect.stringContaining('(livraison échouée)'),
      }),
    );
  });

  it("ignore les autres statuts de livraison et une commande qui n'est pas annulée", async () => {
    const livree = monter([{ ...COMMANDE, status: OrderStatus.COMPLETED }]);
    await livree.listener.apresLivraisonEchouee({
      delivery: { id: 'livraison-1', order_id: COMMANDE.id },
      new_statut: DeliveryStatut.DELIVERED,
    } as never);
    await livree.listener.apresLivraisonEchouee({
      delivery: { id: 'livraison-1', order_id: COMMANDE.id },
      new_statut: DeliveryStatut.FAILED,
    } as never);

    expect(livree.order.findUnique).toHaveBeenCalledTimes(1);
    expect(livree.base.voucher.lignes[0].remaining_amount).toBe(2000);
    expect(livree.auditService.record).not.toHaveBeenCalled();
  });

  it("déjà rendu par l'annulation du personnel : l'événement ne rend rien une seconde fois", async () => {
    const outils = monter([{ ...COMMANDE }]);
    await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION', acteurId: 'agent-1', acteurRole: 'ADMIN' });
    await outils.listener.apresCourseAnnulee({ course: { id: 'course-1' }, cancelled_by: 'admin' } as never);

    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(0);
  });

  it('ne lève jamais : une lecture en échec est seulement journalisée', async () => {
    const outils = monter([]);
    outils.order.findMany.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(
      outils.listener.apresCourseAnnulee({ course: { id: 'course-1' }, cancelled_by: 'admin' } as never),
    ).resolves.toBeUndefined();
  });
});

describe('CouponRestitutionListener : filet des restitutions interrompues', () => {
  const HEURE = 60 * 60 * 1000;
  const maintenant = new Date('2026-09-26T12:00:00Z');

  function monterFilet() {
    const outils = monter([{ ...COMMANDE }]);
    outils.listener.demarrage = new Date(maintenant.getTime() - 72 * HEURE);
    // Les filtres sur la commande liée sont testés par la requête envoyée ; la
    // base en mémoire ne sait pas les évaluer.
    const lectureBons = jest.fn(async (_args: any) => [{ order_id: COMMANDE.id }]);
    const lectureCodes = jest.fn(async (_args: any) => [{ order_id: COMMANDE.id }]);
    (outils.listener as any).prisma = {
      ...(outils.listener as any).prisma,
      redemption: { findMany: lectureBons },
      promoCodeUsage: { findMany: lectureCodes },
    };
    return { ...outils, lectureBons, lectureCodes };
  }

  it('est planifié toutes les 10 minutes', () => {
    const planif = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', CouponRestitutionListener.prototype.rattraperRestitutions);
    expect(planif?.cronTime).toBe('0 */10 * * * *');
  });

  it("rend le coupon d'une commande annulée dont la restitution a été interrompue", async () => {
    const outils = monterFilet();
    const rendues = await outils.listener.rattraperRestitutions(maintenant);

    expect(rendues).toBe(1);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(0);
    // Fenêtre : 48 heures, sans les 5 dernières minutes.
    expect(outils.lectureBons).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entity_status: EntityStatus.ACTIVE,
          order: {
            status: OrderStatus.CANCELLED,
            cancelled_at: {
              gte: new Date(maintenant.getTime() - 48 * HEURE),
              lte: new Date(maintenant.getTime() - 5 * 60 * 1000),
            },
          },
        },
      }),
    );
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor_id: null, summary: expect.stringContaining('(rattrapage automatique)') }),
    );
  });

  it('ne remonte jamais avant le démarrage du serveur', async () => {
    const outils = monterFilet();
    outils.listener.demarrage = new Date(maintenant.getTime() - 2 * HEURE);
    await outils.listener.rattraperRestitutions(maintenant);
    expect(outils.lectureBons.mock.calls[0][0].where.order.cancelled_at.gte).toEqual(outils.listener.demarrage);
  });

  it('ne fait rien pendant les 5 premières minutes après le démarrage', async () => {
    const outils = monterFilet();
    outils.listener.demarrage = new Date(maintenant.getTime() - 60 * 1000);
    await expect(outils.listener.rattraperRestitutions(maintenant)).resolves.toBe(0);
    expect(outils.lectureBons).not.toHaveBeenCalled();
  });

  it("repassé sur une commande déjà rendue, il ne rend rien", async () => {
    const outils = monterFilet();
    await outils.listener.rattraperRestitutions(maintenant);
    await expect(outils.listener.rattraperRestitutions(maintenant)).resolves.toBe(0);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
  });
});
