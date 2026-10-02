/**
 * Points utilisés rendus quand l'annulation vient du module des courses
 * (course annulée, livraison échouée), qui écrit CANCELLED sans passer par
 * updateStatus, et filet périodique.
 *
 * LoyaltyService RÉEL sur la base en mémoire.
 */
import { DeliveryStatut, LoyaltyPointType, OrderStatus } from '@prisma/client';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import {
  CLIENT,
  COMMANDE,
  commande,
  monterFidelite,
} from 'src/modules/fidelity/services/loyalty.base-simulee-spec';
import { PointsRestitutionListener } from './points-restitution.listener';

const MAINTENANT = new Date('2026-10-02T12:00:00Z');

/** Commande de la course « course-1 », payée et déduite, puis annulée en route. */
async function monter({ annuleeIlYa = 30 * 60 * 1000 }: { annuleeIlYa?: number } = {}) {
  const fidelite = monterFidelite({
    solde: 400,
    commandes: [commande({ delivery: { course_id: 'course-1' } })],
  });
  await fidelite.service.redeemPoints({ customer_id: CLIENT, points: 150, order_id: COMMANDE, reason: 'x' });
  Object.assign(fidelite.tables.order[0], {
    status: OrderStatus.CANCELLED,
    cancelled_at: new Date(MAINTENANT.getTime() - annuleeIlYa),
  });
  const listener = new PointsRestitutionListener(fidelite.prisma as never, fidelite.service);
  listener.demarrage = new Date('2026-10-01T00:00:00Z');
  (listener as unknown as { logger: unknown }).logger = { error: jest.fn(), warn: jest.fn() };
  return { ...fidelite, listener };
}

describe('PointsRestitutionListener', () => {
  it('écoute les deux événements du module des courses', () => {
    const noms = (methode: (...args: never[]) => unknown) =>
      JSON.stringify(Reflect.getMetadata('EVENT_LISTENER_METADATA', methode));
    expect(noms(PointsRestitutionListener.prototype.apresCourseAnnulee)).toContain(CourseChannels.COURSE_CANCELLED);
    expect(noms(PointsRestitutionListener.prototype.apresLivraisonEchouee)).toContain(
      CourseChannels.DELIVERY_STATUT_CHANGED,
    );
  });

  it('course annulée : rend les points des commandes annulées de la course', async () => {
    const outils = await monter();
    expect(outils.solde()).toBe(250);

    await outils.listener.apresCourseAnnulee({ course: { id: 'course-1' }, cancelled_by: 'system' } as never);

    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(1);
  });

  it('course d’une autre commande : rien', async () => {
    const outils = await monter();

    await outils.listener.apresCourseAnnulee({ course: { id: 'course-2' }, cancelled_by: 'system' } as never);

    expect(outils.solde()).toBe(250);
  });

  it('livraison échouée : rend les points ; un autre statut de livraison ne fait rien', async () => {
    const outils = await monter();

    await outils.listener.apresLivraisonEchouee({
      new_statut: DeliveryStatut.DELIVERED,
      delivery: { id: 'l1', order_id: COMMANDE },
    } as never);
    expect(outils.solde()).toBe(250);

    await outils.listener.apresLivraisonEchouee({
      new_statut: DeliveryStatut.FAILED,
      delivery: { id: 'l1', order_id: COMMANDE },
    } as never);
    expect(outils.solde()).toBe(400);
  });

  it('filet : rend une annulation récente oubliée, une seule fois même si l’événement passe aussi', async () => {
    const outils = await monter();

    expect(await outils.listener.rattraperRestitutions(MAINTENANT)).toBe(1);
    await outils.listener.apresCourseAnnulee({ course: { id: 'course-1' }, cancelled_by: 'system' } as never);
    expect(await outils.listener.rattraperRestitutions(MAINTENANT)).toBe(0);

    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(1);
  });

  it('filet : une commande déjà remboursée n’est plus relue (sa ligne de retrait reste REDEEMED)', async () => {
    const outils = await monter();
    await outils.service.rendrePointsUtilises(COMMANDE);
    const rendre = jest.spyOn(outils.service, 'rendrePointsUtilises');

    expect(await outils.listener.rattraperRestitutions(MAINTENANT)).toBe(0);
    await outils.listener.apresCourseAnnulee({ course: { id: 'course-1' }, cancelled_by: 'system' } as never);

    // Elle ne prend plus de place dans le lot du filet.
    expect(rendre).not.toHaveBeenCalled();
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
    expect(outils.solde()).toBe(400);
  });

  it('filet : laisse au chemin normal les annulations de moins de 5 minutes', async () => {
    const outils = await monter({ annuleeIlYa: 60 * 1000 });

    expect(await outils.listener.rattraperRestitutions(MAINTENANT)).toBe(0);
    expect(outils.solde()).toBe(250);
  });

  it('filet : ne remonte pas avant le démarrage du serveur', async () => {
    const outils = await monter({ annuleeIlYa: 30 * 60 * 1000 });
    outils.listener.demarrage = new Date(MAINTENANT.getTime() - 10 * 60 * 1000);

    expect(await outils.listener.rattraperRestitutions(MAINTENANT)).toBe(0);
  });
});
