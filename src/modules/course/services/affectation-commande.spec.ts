/**
 * Gestes du siège sur une commande (demande du 06/11) : « Affecter à un
 * livreur », même en course, « Retirer de la course » et la fermeture de la
 * livraison d'une commande terminée par l'administrateur.
 *
 * Vrais services, base simulée, aucun appel sortant.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DeliveryService,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  OrderType,
} from '@prisma/client';

import { OrderHelper } from 'src/modules/order/helpers/order.helper';
import { OrderService } from 'src/modules/order/services/order.service';

import { CourseChannels } from '../enums/course-channels';
import {
  MESSAGE_AUTRE_RESTAURANT_LIVREUR,
  MESSAGE_DEJA_CHEZ_CE_LIVREUR,
  MESSAGE_PAS_A_LIVRER,
  MESSAGE_PAS_ENCORE_PRETE,
  messageAffectation,
  refusCommandeAAffecter,
} from '../helpers/affectation-commande.rules';
import { whereCoursesARemettre } from '../helpers/code-retrait.rules';
import { CourseHelper } from '../helpers/course.helper';
import { messageSacChezLeLivreur } from '../helpers/detachement-commande.rules';
import { journeeDeService } from '../helpers/journee-service.rules';
import { MESSAGE_COMMANDE_ANNULEE } from '../helpers/sac-rapporte.rules';
import { CommandeFinieCourseListener } from '../listeners/commande-finie-course.listener';
import { AffectationCommandeService } from './affectation-commande.service';
import { AU_COMPTOIR, avant, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';
import { course, livraison, livreur, offre, RESTO } from './base-dispatch.simulee-spec';
import { DetachementCommandeService } from './detachement-commande.service';
import { DispatchJournalService } from './dispatch-journal.service';

const ADMIN = { id: 'u-admin', role: 'ADMIN' };

function monterCas(donnees: Parameters<typeof monter>[0]) {
  const h = monter(donnees);
  const turbo = Object.assign(h.turbo, {
    annulerCourseGroupe: jest.fn(
      async (_p: { referenceCourse: string; apikey: string }): Promise<{ ok: boolean; courierAssigned?: boolean }> => ({
        ok: true,
      }),
    ),
  });
  const push = Object.assign(h.push, {
    notifyCourseCancelled: jest.fn(),
    notifyCourseAssigned: jest.fn(),
    notifyCourseCompleted: jest.fn(),
  });
  const cloche = Object.assign(h.cloche, { sendTurboCourseCancelledBell: jest.fn(async (_p: unknown) => undefined) });
  const detachement = new DetachementCommandeService(
    h.base.prisma,
    h.application,
    h.actions,
    h.offres,
    turbo as never,
    new DispatchJournalService(h.base.prisma),
    h.courseEvent,
    h.actionsLivraison,
    cloche as never,
  );
  const passerelle = { livreurConnecte: jest.fn(async (): Promise<boolean | null> => true) };
  const duree = { estimerDureeTournee: jest.fn(async () => undefined) };
  const service = new AffectationCommandeService(
    h.base.prisma,
    new CourseHelper(),
    h.courseEvent,
    push as never,
    h.appli.service,
    h.cloture,
    passerelle as never,
    duree as never,
    detachement,
  );
  const affecter = (orderId: string, livreurId: string) => service.affecter(orderId, livreurId, ADMIN as never, MAINTENANT);
  const livraisonDe = (orderId: string) => h.base.livraisons.find((l) => l.order_id === orderId);
  return { h, turbo, push, detachement, passerelle, duree, affecter, livraisonDe };
}

const koffi = (s: Record<string, unknown> = {}) =>
  livreur({ ...AU_COMPTOIR, first_name: 'Koffi', last_available_at: avant(300), protocole_appli: 4, ...s });
const awa = (s: Record<string, unknown> = {}) =>
  livreur({ ...AU_COMPTOIR, first_name: 'Awa', last_available_at: avant(600), protocole_appli: 4, ...s });

const coursDe = (d: Record<string, unknown>, s: Record<string, unknown> = {}) =>
  course({
    statut: CourseStatut.ACCEPTED,
    deliverer_id: d.id,
    assigned_at: avant(120),
    pickup_code: '421',
    created_at: avant(300),
    ...s,
  });

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('règles de « Affecter à un livreur »', () => {
  const lue = (s: Record<string, unknown> = {}) => ({
    status: OrderStatus.READY,
    type: OrderType.DELIVERY,
    delivery: null,
    ...s,
  });

  it.each([
    ['annulée', { status: OrderStatus.CANCELLED }, MESSAGE_COMMANDE_ANNULEE],
    ['à emporter', { type: OrderType.PICKUP }, MESSAGE_PAS_A_LIVRER],
    ['en préparation', { status: OrderStatus.IN_PROGRESS }, MESSAGE_PAS_ENCORE_PRETE],
    ['sac déjà remis', { status: OrderStatus.PICKED_UP }, messageSacChezLeLivreur(null)],
    ['terminée', { status: OrderStatus.COMPLETED }, messageSacChezLeLivreur(null)],
  ])('commande %s : refus en clair', (_nom, s, message) => {
    expect(refusCommandeAAffecter(lue(s) as never, 'l1')).toBe(message);
  });

  it('prête : acceptée, même dans la course d’un autre livreur', () => {
    const delivery = { statut: DeliveryStatut.PENDING, course: { deliverer_id: 'l2' } };
    expect(refusCommandeAAffecter(lue({ delivery }) as never, 'l1')).toBeNull();
  });

  it('déjà chez ce livreur : refus ; livraison morte chez lui : acceptée', () => {
    const active = { statut: DeliveryStatut.PENDING, course: { deliverer_id: 'l1' } };
    expect(refusCommandeAAffecter(lue({ delivery: active }) as never, 'l1')).toBe(MESSAGE_DEJA_CHEZ_CE_LIVREUR);
    const morte = { statut: DeliveryStatut.CANCELLED, course: { deliverer_id: 'l1' } };
    expect(refusCommandeAAffecter(lue({ delivery: morte }) as never, 'l1')).toBeNull();
  });

  it('message au siège : nouvelle course, ajout, déjà parti, par notification', () => {
    const base = { reference: 'CMD-A', prenom: 'Koffi', appliConnectee: true };
    expect(messageAffectation({ ...base, nouvelle: true, statutCourse: CourseStatut.ACCEPTED })).toBe(
      'CMD-A affectée à Koffi.',
    );
    expect(messageAffectation({ ...base, nouvelle: false, statutCourse: CourseStatut.ACCEPTED })).toBe(
      'CMD-A ajoutée à la course de Koffi.',
    );
    expect(messageAffectation({ ...base, nouvelle: false, statutCourse: CourseStatut.IN_DELIVERY })).toBe(
      'CMD-A ajoutée à la course de Koffi, à récupérer au restaurant.',
    );
    expect(
      messageAffectation({ ...base, appliConnectee: false, nouvelle: true, statutCourse: CourseStatut.ACCEPTED }),
    ).toBe('CMD-A affectée à Koffi, prévenu par notification.');
  });
});

describe('Affecter à un livreur', () => {
  it('livreur sans course : course créée, déjà acceptée, code du client gardé, hors de la file', async () => {
    const d = koffi();
    const a = prete({ recovery_code: '4821', delivery_fee: 1000 });
    const t = monterCas({ commandes: [a], livreurs: [d] });

    const r = await t.affecter(a.id, d.id);

    const creee = t.h.base.courses[0];
    expect(creee).toMatchObject({ statut: CourseStatut.ACCEPTED, deliverer_id: d.id, assigned_at: MAINTENANT });
    expect(t.livraisonDe(a.id)).toMatchObject({
      course_id: creee.id,
      delivery_pin: '4821',
      statut: DeliveryStatut.PENDING,
      sequence_order: 1,
    });
    expect(d.last_available_at).toBeNull();
    expect(r).toMatchObject({ nouvelle_course: true, course_id: creee.id, appli_connectee: true });
    expect(r.message).toContain('affectée à Koffi');
    expect(t.push.notifyCourseAssigned).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d.id, courseId: creee.id }));
    expect(t.h.emis.filter((e) => e.canal === CourseChannels.COURSE_ASSIGNED)).toHaveLength(1);
    expect(t.h.journalDe('COMMANDE_AFFECTEE')[0]).toMatchObject({ motif: 'NOUVELLE_COURSE', order_id: a.id, deliverer_id: d.id });
  });

  it('livreur qui va au restaurant : la commande rejoint sa course, sans seconde course', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d);
    const x = prete({ status: OrderStatus.READY, recovery_code: '1111' });
    const a = prete({ recovery_code: '4821' });
    const t = monterCas({
      courses: [k],
      commandes: [x, a],
      livraisons: [livraison({ course_id: k.id, order_id: x.id, sequence_order: 1 })],
      livreurs: [d],
    });

    const r = await t.affecter(a.id, d.id);

    expect(t.h.base.courses).toHaveLength(1);
    expect(t.livraisonDe(a.id)).toMatchObject({
      course_id: k.id,
      sequence_order: 2,
      ajoutee_at: MAINTENANT,
      ajoutee_apres_retrait: false,
    });
    expect(r.nouvelle_course).toBe(false);
    expect(t.h.push.notifyCommandeAjoutee).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d.id, courseId: k.id, apresRetrait: false, total: 2 }),
    );
    expect(t.duree.estimerDureeTournee).toHaveBeenCalledWith(k.id);
    expect(t.h.journalDe('COMMANDE_AFFECTEE')[0]).toMatchObject({ motif: 'LIVREUR_EN_COURSE' });
  });

  it('livreur déjà parti : elle rejoint sa tournée, et la caisse la remet avec son code', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, picked_up_at: avant(60), parti_at: avant(30) });
    const x = prete({ status: OrderStatus.PICKED_UP });
    const a = prete();
    const t = monterCas({
      courses: [k],
      commandes: [x, a],
      livraisons: [livraison({ course_id: k.id, order_id: x.id, sequence_order: 1, statut: DeliveryStatut.IN_ROUTE })],
      livreurs: [d],
    });

    const r = await t.affecter(a.id, d.id);

    expect(r.message).toContain('à récupérer au restaurant');
    expect(t.livraisonDe(a.id)).toMatchObject({ course_id: k.id, ajoutee_apres_retrait: false });
    expect(t.h.push.notifyCommandeAjoutee).toHaveBeenCalledWith(expect.objectContaining({ apresRetrait: true, code: '421' }));
    // Même règle qu'un sac oublié : la caisse retrouve la course avec le code.
    const trouvee = await t.h.base.prisma.course.findFirst({
      where: whereCoursesARemettre('421', RESTO, journeeDeService(MAINTENANT)),
    });
    expect(trouvee?.id).toBe(k.id);
  });

  it('commande sur la course d’un autre livreur : elle la quitte, il est prévenu, sa course continue', async () => {
    const d1 = koffi({ last_available_at: null });
    const d2 = awa();
    const k = coursDe(d1);
    const a = prete({ recovery_code: '4821' });
    const b = prete();
    const t = monterCas({
      courses: [k],
      commandes: [a, b],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1, delivery_pin: '4821' }),
        livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 }),
      ],
      livreurs: [d1, d2],
    });

    await t.affecter(a.id, d2.id);

    expect(t.h.base.livraisons.filter((l) => l.course_id === k.id).map((l) => l.order_id)).toEqual([b.id]);
    expect(k.statut).toBe(CourseStatut.ACCEPTED);
    const neuve = t.h.base.courses.find((c) => c.deliverer_id === d2.id)!;
    expect(t.livraisonDe(a.id)).toMatchObject({ course_id: neuve.id, delivery_pin: '4821' });
    expect(t.h.push.notifyCommandeRetiree).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id, courseId: k.id }));
  });

  it('commande confiée à Turbo : groupe annulé chez eux, elle passe aux livreurs Chicken Nation', async () => {
    const d = koffi();
    const k = course({ statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(120), reference: 'CRS-T' });
    const a = prete({ delivery_service: DeliveryService.TURBO });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d],
    });

    await t.affecter(a.id, d.id);

    expect(t.turbo.annulerCourseGroupe).toHaveBeenCalledWith(expect.objectContaining({ referenceCourse: 'CRS-T' }));
    expect(k.statut).toBe(CourseStatut.CANCELLED);
    expect(a.delivery_service).toBe(DeliveryService.CHICKEN_NATION);
    expect(t.livraisonDe(a.id)?.course_id).not.toBe(k.id);
  });

  it('Turbo refuse, un de leurs livreurs a accepté : rien ne bouge', async () => {
    const d = koffi();
    const k = course({ statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(120) });
    const a = prete({ delivery_service: DeliveryService.TURBO });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d],
    });
    t.turbo.annulerCourseGroupe.mockResolvedValue({ ok: false, courierAssigned: true });

    await expect(t.affecter(a.id, d.id)).rejects.toThrow('Un livreur Turbo a déjà accepté');

    expect(t.livraisonDe(a.id)?.course_id).toBe(k.id);
    expect(a.delivery_service).toBe(DeliveryService.TURBO);
    expect(t.h.base.courses).toHaveLength(1);
  });

  it('course annulée : son ancienne livraison s’efface, le code du client reste', async () => {
    const d = koffi();
    const k = course({ statut: CourseStatut.CANCELLED });
    const a = prete({ recovery_code: '4821' });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, statut: DeliveryStatut.CANCELLED, delivery_pin: '4821' })],
      livreurs: [d],
    });

    await t.affecter(a.id, d.id);

    expect(t.h.base.livraisons).toHaveLength(1);
    expect(t.livraisonDe(a.id)).toMatchObject({ statut: DeliveryStatut.PENDING, delivery_pin: '4821' });
    expect(t.livraisonDe(a.id)?.course_id).not.toBe(k.id);
  });

  it('offre en attente chez le livreur choisi : close sans pénalité avant l’affectation', async () => {
    const d = koffi();
    const autre = course({ statut: CourseStatut.PENDING_ASSIGNMENT });
    const o = offre({ course_id: autre.id, deliverer_id: d.id, status: CourseOfferStatus.PENDING, expires_at: avant(-60) });
    const a = prete();
    const t = monterCas({ courses: [autre], commandes: [a], livreurs: [d], offres: [o] });

    await t.affecter(a.id, d.id);

    expect(o.status).not.toBe(CourseOfferStatus.PENDING);
    expect(t.livraisonDe(a.id)).toBeDefined();
  });

  it('livreur en pause : refus sans course, permis s’il est en course', async () => {
    const enPause = { pause_until: avant(-600) };
    const libre = koffi(enPause);
    const a = prete();
    const t = monterCas({ commandes: [a], livreurs: [libre] });
    await expect(t.affecter(a.id, libre.id)).rejects.toThrow(/en pause/i);
    expect(t.h.base.courses).toHaveLength(0);

    const enCourse = koffi({ ...enPause, last_available_at: null });
    const k = coursDe(enCourse);
    const b = prete();
    const t2 = monterCas({ courses: [k], commandes: [b], livreurs: [enCourse] });
    await expect(t2.affecter(b.id, enCourse.id)).resolves.toMatchObject({ nouvelle_course: false });
  });

  it('livreur d’un autre restaurant : refus', async () => {
    const d = koffi({ restaurant_id: 'autre-resto' });
    const a = prete();
    const t = monterCas({ commandes: [a], livreurs: [d] });
    await expect(t.affecter(a.id, d.id)).rejects.toThrow(MESSAGE_AUTRE_RESTAURANT_LIVREUR);
  });

  it('commande inconnue ou supprimée : 404 ; livreur inconnu : 404', async () => {
    const d = koffi();
    const a = prete({ entity_status: EntityStatus.DELETED });
    const b = prete();
    const t = monterCas({ commandes: [a, b], livreurs: [d] });
    await expect(t.affecter('inconnue', d.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.affecter(a.id, d.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.affecter(b.id, 'inconnu')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Retirer de la course', () => {
  it('il reste d’autres commandes : la livraison part, le livreur est prévenu, le passage est demandé', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d);
    const a = prete();
    const b = prete();
    const t = monterCas({
      courses: [k],
      commandes: [a, b],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 }),
      ],
      livreurs: [d],
    });

    const r = await t.detachement.retirerDeLaCourse(a.id, MAINTENANT);

    expect(r.message).toContain('retirée de la course');
    expect(t.livraisonDe(a.id)).toBeUndefined();
    expect(k.statut).toBe(CourseStatut.ACCEPTED);
    expect(a.status).toBe(OrderStatus.READY);
    expect(t.h.push.notifyCommandeRetiree).toHaveBeenCalled();
    expect(t.h.journalDe('COMMANDE_DETACHEE')[0]).toMatchObject({ motif: 'RETIREE_PAR_LE_SIEGE' });
  });

  it('course confiée à Turbo : annulée chez eux, la commande passe aux livreurs Chicken Nation', async () => {
    const k = course({ statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(120) });
    const a = prete({ delivery_service: DeliveryService.TURBO });
    const t = monterCas({ courses: [k], commandes: [a], livraisons: [livraison({ course_id: k.id, order_id: a.id })] });

    await t.detachement.retirerDeLaCourse(a.id, MAINTENANT);

    expect(t.turbo.annulerCourseGroupe).toHaveBeenCalled();
    expect(k).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'system' });
    expect(a.delivery_service).toBe(DeliveryService.CHICKEN_NATION);
    expect(t.livraisonDe(a.id)).toBeUndefined();
  });

  it('sac déjà remis au livreur : refus, rien ne bouge', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY });
    const a = prete({ status: OrderStatus.PICKED_UP });
    const t = monterCas({ courses: [k], commandes: [a], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d] });

    await expect(t.detachement.retirerDeLaCourse(a.id, MAINTENANT)).rejects.toThrow(messageSacChezLeLivreur(null));
    expect(t.livraisonDe(a.id)).toBeDefined();
  });

  it('dans aucune course : refus ; commande inconnue : 404', async () => {
    const a = prete();
    const t = monterCas({ commandes: [a] });
    await expect(t.detachement.retirerDeLaCourse(a.id, MAINTENANT)).rejects.toBeInstanceOf(ConflictException);
    await expect(t.detachement.retirerDeLaCourse('inconnue', MAINTENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Commande terminée par l’administrateur : sa livraison se ferme', () => {
  it('dernière commande d’une course acceptée : course terminée, sans heure de livraison', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d);
    const a = prete({ status: OrderStatus.COMPLETED, reference: 'CMD-A' });
    const t = monterCas({ courses: [k], commandes: [a], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d] });

    await t.detachement.fermerLivraisonTerminee({ orderId: a.id, reference: 'CMD-A' }, MAINTENANT);

    expect(t.livraisonDe(a.id)?.statut).toBe(DeliveryStatut.DELIVERED);
    expect(t.livraisonDe(a.id)?.delivered_at ?? null).toBeNull();
    expect(k.statut).toBe(CourseStatut.COMPLETED);
  });

  it('il reste un client : la course continue, le livreur est prévenu', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, parti_at: avant(30) });
    const a = prete({ status: OrderStatus.COMPLETED, reference: 'CMD-A' });
    const b = prete({ status: OrderStatus.PICKED_UP });
    const t = monterCas({
      courses: [k],
      commandes: [a, b],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1, statut: DeliveryStatut.IN_ROUTE }),
        livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 }),
      ],
      livreurs: [d],
    });

    await t.detachement.fermerLivraisonTerminee({ orderId: a.id, reference: 'CMD-A' }, MAINTENANT);

    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.h.push.notifyCommandeRetiree).toHaveBeenCalledWith(expect.objectContaining({ commande: 'CMD-A' }));
  });

  it('course sans livreur : annulée, ses offres se ferment', async () => {
    const k = course({ statut: CourseStatut.PENDING_ASSIGNMENT });
    const a = prete({ status: OrderStatus.COMPLETED });
    const t = monterCas({ courses: [k], commandes: [a], livraisons: [livraison({ course_id: k.id, order_id: a.id })] });

    await t.detachement.fermerLivraisonTerminee({ orderId: a.id, reference: 'CMD-A' }, MAINTENANT);

    expect(k).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'system' });
  });

  it('course confiée à Turbo : laissée à son propre chemin (CommandeFinieListener)', async () => {
    const k = course({ statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(60) });
    const a = prete({ status: OrderStatus.COMPLETED });
    const t = monterCas({ courses: [k], commandes: [a], livraisons: [livraison({ course_id: k.id, order_id: a.id })] });

    await t.detachement.fermerLivraisonTerminee({ orderId: a.id, reference: 'CMD-A' }, MAINTENANT);

    expect(t.livraisonDe(a.id)?.statut).toBe(DeliveryStatut.PENDING);
    expect(k.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });
});

describe('Terminer une commande termine sa course, quel que soit le geste', () => {
  const finie = (t: ReturnType<typeof monterCas>, order: unknown) =>
    new CommandeFinieCourseListener(t.detachement).onStatutCommande({ order } as never);

  it.each([
    ['terminée', OrderStatus.COMPLETED],
    ['récupérée, à encaisser', OrderStatus.COLLECTED],
  ])('%s à la caisse : la course du livreur se termine, la commande ne bouge pas', async (_nom, status) => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, parti_at: avant(30) });
    const a = prete({ status, reference: 'CMD-A' });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, statut: DeliveryStatut.IN_ROUTE })],
      livreurs: [d],
    });

    await finie(t, a);

    expect(t.livraisonDe(a.id)?.statut).toBe(DeliveryStatut.DELIVERED);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
    expect(a.status).toBe(status);
  });

  it.each([OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.CANCELLED])('%s : la course continue', async (status) => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, parti_at: avant(30) });
    const a = prete({ status });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, statut: DeliveryStatut.IN_ROUTE })],
      livreurs: [d],
    });

    await finie(t, a);

    expect(t.livraisonDe(a.id)?.statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('commande à emporter : aucune course à fermer', async () => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, parti_at: avant(30) });
    const a = prete({ status: OrderStatus.COMPLETED, type: OrderType.PICKUP });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, statut: DeliveryStatut.IN_ROUTE })],
      livreurs: [d],
    });

    await finie(t, a);

    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
  });
});

describe('La fin d’une course ne termine jamais une commande', () => {
  it.each([true, false])('remise, payée = %s : la commande reste en livraison', async (paied) => {
    const d = koffi({ last_available_at: null });
    const k = coursDe(d, { statut: CourseStatut.IN_DELIVERY, parti_at: avant(30) });
    const a = prete({ status: OrderStatus.PICKED_UP, paied });
    const t = monterCas({
      courses: [k],
      commandes: [a],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, statut: DeliveryStatut.FAILED })],
      livreurs: [d],
    });

    await t.h.actionsLivraison.checkCourseCompletion(k.id);

    expect(k.statut).toBe(CourseStatut.COMPLETED);
    expect(a.status).toBe(OrderStatus.PICKED_UP);
  });
});

describe('Terminer une commande : la règle du statut', () => {
  function monterService(commande: Record<string, unknown>) {
    const service = Object.create(OrderService.prototype) as OrderService;
    const updateStatus = jest.fn(async () => ({ ...commande, status: 'X' }));
    Object.assign(service, {
      findById: jest.fn(async () => ({ id: 'o1', reference: 'CMD-A', ...commande })),
      updateStatus,
    });
    return { service, updateStatus };
  }
  const user = { id: 'u-admin', role: 'ADMIN' } as never;

  it('payée : terminée, même en préparation', async () => {
    const t = monterService({ status: OrderStatus.IN_PROGRESS, paied: true });

    await t.service.terminerParAdmin('o1', user);

    expect(t.updateStatus).toHaveBeenCalledWith('o1', OrderStatus.COMPLETED, expect.objectContaining({ role: 'ADMIN' }), {
      sauterEtapes: true,
    });
  });

  it('pas encore payée : récupérée, à encaisser, jamais terminée sans paiement', async () => {
    const t = monterService({ status: OrderStatus.IN_PROGRESS, paied: false });

    await t.service.terminerParAdmin('o1', user);

    expect(t.updateStatus).toHaveBeenCalledWith('o1', OrderStatus.COLLECTED, expect.anything(), { sauterEtapes: true });
  });

  it.each([
    ['déjà terminée', { status: OrderStatus.COMPLETED, paied: true }],
    ['en attente', { status: OrderStatus.PENDING, paied: false }],
    ['récupérée, à encaisser', { status: OrderStatus.COLLECTED, paied: false }],
  ])('%s : refus', async (_nom, commande) => {
    const t = monterService(commande);
    await expect(t.service.terminerParAdmin('o1', user)).rejects.toBeInstanceOf(ConflictException);
    expect(t.updateStatus).not.toHaveBeenCalled();
  });

  it('sauter les étapes : seulement pour ce geste, et jamais depuis une commande annulée', () => {
    const helper = Object.create(OrderHelper.prototype) as OrderHelper;
    const { DELIVERY } = OrderType;
    expect(() => helper.validateStatusTransition(DELIVERY, OrderStatus.IN_PROGRESS, OrderStatus.COLLECTED)).toThrow();
    expect(() =>
      helper.validateStatusTransition(DELIVERY, OrderStatus.IN_PROGRESS, OrderStatus.COLLECTED, { sauterEtapes: true }),
    ).not.toThrow();
    expect(() =>
      helper.validateStatusTransition(DELIVERY, OrderStatus.CANCELLED, OrderStatus.COLLECTED, { sauterEtapes: true }),
    ).toThrow();
  });
});
