/**
 * COMMANDE À LIVRER DÉJÀ DANS UNE COURSE, PASSÉE À EMPORTER OU SUR PLACE
 * (demande du client du 27/10 : « une commande à livrer qui est déjà groupée
 * pour une course et qui passe à emporter doit être retirée de la course »).
 *
 * Avant ce correctif, « Modifier la commande » n'écrivait que la commande :
 * la livraison restait dans la course, qui cherchait toujours un livreur, et
 * le livreur partait avec un sac que le client venait chercher. Chaque test
 * ci-dessous échouait.
 *
 * `OrderService.update` est appelé en isolation (seules les dépendances
 * qu'il lit sont greffées), avec les VRAIS services de la course
 * (`DetachementCommandeService`, annulation, annonces, relance, offres) sur
 * la base simulée du banc du planificateur : les `where` y sont évalués et
 * une transaction qui lève est annulée, comme en base. Turbo est simulé.
 */
import { ConflictException } from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DeliveryService,
  DeliveryStatut,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  User,
  UserRole,
  UserType,
} from '@prisma/client';

import { CourseChannels } from 'src/modules/course/enums/course-channels';
import {
  MESSAGE_COURSE_CHANGEE,
  messageCoursePartie,
  messageLivreurTurboEngage,
  messageSacChezLeLivreur,
  RAISON_TURBO_SANS_CHANGEMENT,
} from 'src/modules/course/helpers/detachement-commande.rules';
import { DispatchListener } from 'src/modules/course/listeners/dispatch.listener';
import { monter } from 'src/modules/course/services/banc-planificateur.simulee-spec';
import { commande, course, livraison, offre } from 'src/modules/course/services/base-dispatch.simulee-spec';
import { DetachementCommandeService } from 'src/modules/course/services/detachement-commande.service';
import { DispatchJournalService } from 'src/modules/course/services/dispatch-journal.service';
import { OrderService } from './order.service';

const LIVREUR = 'livreur-type-commande';
const callCenter = { id: 'u1', type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER, restaurant_id: null } as unknown as User;
const admin = { id: 'u2', type: UserType.BACKOFFICE, role: UserRole.ADMIN, restaurant_id: null } as unknown as User;

const ilYa = (s: number) => new Date(Date.now() - s * 1000);
const dansS = (s: number) => new Date(Date.now() + s * 1000);

/** Commande du centre d'appels, à livrer, prête, payée à la livraison. */
const aLivrer = (surcharge: Record<string, unknown> = {}) =>
  commande({
    status: OrderStatus.READY,
    type: OrderType.DELIVERY,
    channel: OrderChannel.CALL_CENTER,
    auto: false,
    payment_method: PaymentMethod.OFFLINE,
    paied: false,
    hubrise_order_id: null,
    code_promo: null,
    points: 0,
    promotion_id: null,
    customer_id: 'client-1',
    net_amount: 10000,
    discount: 0,
    tax: 0,
    delivery_fee: 1000,
    amount: 11000,
    ...surcharge,
  });

/**
 * Une course et ses commandes (la première, A, est celle qui change de type),
 * les vrais services de la course, et `OrderService.update` branché dessus.
 */
function monterCas(
  surchargeCourse: Record<string, unknown>,
  commandes: Record<string, unknown>[],
  options: { offres?: Record<string, unknown>[]; livraisons?: Record<string, unknown>[] } = {},
) {
  const c = course({ reference: 'CRS-1', pickup_code: '421', ...surchargeCourse });
  const lignes = commandes.map((s, i) => aLivrer({ reference: `CMD-${String.fromCharCode(65 + i)}`, ...s }));
  const livraisons = lignes.map((o, i) =>
    livraison({ course_id: c.id, order_id: o.id, sequence_order: i + 1, ...(options.livraisons?.[i] ?? {}) }),
  );
  const h = monter({ courses: [c], commandes: lignes, livraisons, offres: options.offres ?? [] });
  // Ce que le banc ne simule pas encore : l'annulation chez Turbo, « Course annulée » au livreur.
  // Mêmes objets que ceux des services du banc (offres, annulation) : ils voient ces ajouts.
  const turbo = Object.assign(h.turbo, {
    annulerCourseGroupe: jest.fn(
      async (_p: { referenceCourse: string; apikey: string }): Promise<{ ok: boolean; courierAssigned?: boolean; uncertain?: boolean }> => ({
        ok: true,
      }),
    ),
  });
  const push = Object.assign(h.push, { notifyCourseCancelled: jest.fn() });
  const journal = new DispatchJournalService(h.base.prisma);
  const detachement = new DetachementCommandeService(
    h.base.prisma,
    h.application,
    h.actions,
    h.offres,
    turbo as never,
    journal,
    h.courseEvent,
  );

  /** Entre la lecture et l'écriture de la commande : ce qu'un collègue, la caisse ou Turbo change en base. */
  let entreTemps: (() => void) | undefined;
  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma: h.base.prisma,
    findById: jest.fn(async (id: string) => ({ ...h.base.commandes.find((o) => o.id === id)!, paiements: [], order_items: [] })),
    recomputeOrderPaiedFlag: jest.fn(),
    orderHelper: {
      calculateEstimatedTime: jest.fn(() => {
        entreTemps?.();
        entreTemps = undefined;
        return null;
      }),
    },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    orderRelance: { noterReprise: jest.fn() },
    promoCodeService: { activateUsageForOrder: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    detachementCommande: detachement,
  };
  Object.assign(service, greffes);

  // L'écouteur de `course:cancelled` : offres closes sans pénalité, livreur remis dans la file.
  const file = { remettreEnFile: jest.fn(async () => true) };
  const ecouteur = new DispatchListener(
    h.base.prisma,
    h.offres,
    {} as never,
    journal,
    {} as never,
    { livreurConnecte: jest.fn(async () => true) } as never,
    h.cloture,
    file as never,
  );
  const diffuserAnnulations = async () => {
    for (const charge of h.emisSur(CourseChannels.COURSE_CANCELLED)) await ecouteur.onCourseAnnulee(charge);
  };

  const [A, B] = h.base.commandes;
  return {
    ...h,
    turbo,
    push,
    service,
    greffes,
    file,
    diffuserAnnulations,
    course: h.base.courses[0],
    A,
    B,
    livraisonDe: (o: Record<string, unknown>) => h.base.livraisons.find((l) => l.order_id === o.id),
    siEntreTemps: (fn: () => void) => {
      entreTemps = fn;
    },
    modifier: (corps: Record<string, unknown>, user: User = callCenter) =>
      service.update(A.id as string, corps as never, {
        userId: user.id,
        user,
        ...(user.role === UserRole.ADMIN ? { skipStatusCheck: true } : {}),
      }),
  };
}

describe('Commande à livrer déjà dans une course, passée à emporter ou sur place', () => {
  it('course sans livreur, avec une autre commande : livraison retirée, frais refaits, offre renvoyée à jour', async () => {
    const t = monterCas({}, [{}, {}], {
      offres: [offre({ deliverer_id: LIVREUR, expires_at: dansS(60) })],
    });
    t.base.offres[0].course_id = t.course.id;

    await t.modifier({ type: OrderType.PICKUP });

    expect(t.A.type).toBe(OrderType.PICKUP);
    expect(t.A.status).toBe(OrderStatus.READY); // jamais annulée
    expect(t.livraisonDe(t.A)).toBeUndefined();
    expect(t.livraisonDe(t.B)?.course_id).toBe(t.course.id);
    expect(t.course.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(t.course.total_delivery_fee).toBe(1000);
    expect(t.journalDe('COMMANDE_DETACHEE')).toEqual([
      expect.objectContaining({ motif: 'PASSEE_A_EMPORTER', order_id: t.A.id, course_id: t.course.id }),
    ]);
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ reason: 'COMMANDE_DETACHEE' }),
    ]);
    // L'offre affichée au livreur sollicité est remplacée (même échéance, une commande de moins).
    const renvois = t.emisSur(CourseChannels.COURSE_OFFER_NEW);
    expect(renvois).toEqual([expect.objectContaining({ deliverer_id: LIVREUR, renvoi: true })]);
    expect(renvois[0].course.deliveries.map((d: { order_id: string }) => d.order_id)).toEqual([t.B.id]);
  });

  it('course sans livreur devenue vide : annulée (pas la commande), offre close sans pénalité', async () => {
    const t = monterCas({}, [{}], { offres: [offre({ deliverer_id: LIVREUR, expires_at: dansS(60) })] });
    t.base.offres[0].course_id = t.course.id;

    await t.modifier({ type: OrderType.PICKUP });
    await t.diffuserAnnulations();

    expect(t.A.type).toBe(OrderType.PICKUP);
    expect(t.A.status).toBe(OrderStatus.READY);
    expect(t.livraisonDe(t.A)).toBeUndefined();
    expect(t.course).toEqual(
      expect.objectContaining({
        statut: CourseStatut.CANCELLED,
        cancelled_by: 'admin',
        cancelled_reason: 'Plus aucune commande à livrer : CMD-A passée à emporter',
      }),
    );
    expect(t.base.offres[0].status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled(); // aucune pénalité
  });

  it('livreur en route, autre commande dans la course : livraison retirée, « Commande retirée » au livreur', async () => {
    const t = monterCas({ statut: CourseStatut.ACCEPTED, deliverer_id: LIVREUR, assigned_at: ilYa(120) }, [{}, {}]);

    await t.modifier({ type: OrderType.TABLE });

    expect(t.A.type).toBe(OrderType.TABLE);
    expect(t.livraisonDe(t.A)).toBeUndefined();
    expect(t.course.statut).toBe(CourseStatut.ACCEPTED);
    expect(t.push.notifyCommandeRetiree).toHaveBeenCalledWith(
      expect.objectContaining({
        delivererId: LIVREUR,
        courseId: t.course.id,
        titre: 'Commande retirée',
        corps: '1 commande à livrer',
        commande: 'CMD-A',
        restantes: 1,
      }),
    );
    // La caisse relit la course sur ce même événement.
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ reason: 'COMMANDE_DETACHEE' }),
    ]);
    expect(t.journalDe('COMMANDE_DETACHEE')[0]).toEqual(expect.objectContaining({ motif: 'PASSEE_SUR_PLACE' }));
  });

  it('livreur au restaurant, commande seule : course annulée, livreur prévenu et remis dans la file à sa place', async () => {
    const acceptee = ilYa(600);
    const t = monterCas({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: LIVREUR, assigned_at: acceptee }, [{}]);

    await t.modifier({ type: OrderType.PICKUP });
    await t.diffuserAnnulations();

    expect(t.A.type).toBe(OrderType.PICKUP);
    expect(t.A.status).toBe(OrderStatus.READY);
    expect(t.course.statut).toBe(CourseStatut.CANCELLED);
    expect(t.push.notifyCourseCancelled).toHaveBeenCalledWith(expect.objectContaining({ delivererId: LIVREUR }));
    // Annulée par le siège : il n'y est pour rien, il reprend la place de son acceptation.
    expect(t.file.remettreEnFile).toHaveBeenCalledWith(LIVREUR, acceptee);
  });

  it('commande déjà remise au livreur (administrateur) : refus en clair, rien n’est écrit', async () => {
    const t = monterCas(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: LIVREUR, picked_up_at: ilYa(60) },
      [{ status: OrderStatus.PICKED_UP }],
    );

    await expect(t.modifier({ type: OrderType.PICKUP }, admin)).rejects.toThrow(
      new ConflictException(messageSacChezLeLivreur(OrderType.PICKUP)),
    );
    expect(t.A.type).toBe(OrderType.DELIVERY);
    expect(t.livraisonDe(t.A)).toBeDefined();
    expect(t.base.prisma.order.update).not.toHaveBeenCalled();
  });

  it('course partie, commande encore au comptoir : refus en clair, rien n’est écrit', async () => {
    const t = monterCas(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: LIVREUR, picked_up_at: ilYa(300), parti_at: ilYa(60) },
      [{}, { status: OrderStatus.PICKED_UP }],
    );

    await expect(t.modifier({ type: OrderType.PICKUP })).rejects.toThrow(
      new ConflictException(messageCoursePartie(OrderType.PICKUP)),
    );
    expect(t.A.type).toBe(OrderType.DELIVERY);
    expect(t.livraisonDe(t.A)).toBeDefined();
  });

  it('remise au comptoir entre la lecture et l’écriture : refus, la course garde la livraison', async () => {
    const t = monterCas({ statut: CourseStatut.ACCEPTED, deliverer_id: LIVREUR }, [{}]);
    t.siEntreTemps(() => {
      t.course.statut = CourseStatut.IN_DELIVERY;
      t.A.status = OrderStatus.PICKED_UP;
    });

    await expect(t.modifier({ type: OrderType.PICKUP })).rejects.toThrow(new ConflictException(MESSAGE_COURSE_CHANGEE));
    expect(t.A.type).toBe(OrderType.DELIVERY);
    expect(t.livraisonDe(t.A)).toBeDefined();
    expect(t.push.notifyCommandeRetiree).not.toHaveBeenCalled();
  });

  it('course confiée à Turbo, commande seule : groupe annulé chez Turbo, course annulée, rien n’est relancé', async () => {
    const t = monterCas({ turbo_escalated_at: ilYa(300) }, [{ delivery_service: DeliveryService.TURBO }]);

    await t.modifier({ type: OrderType.PICKUP });

    expect(t.turbo.annulerCourseGroupe).toHaveBeenCalledWith({ referenceCourse: 'CRS-1', apikey: 'cle' });
    expect(t.A.type).toBe(OrderType.PICKUP);
    expect(t.livraisonDe(t.A)).toBeUndefined();
    expect(t.course).toEqual(expect.objectContaining({ statut: CourseStatut.CANCELLED, cancelled_by: 'system' }));
    expect(t.turbo.creerCourseGroupe).not.toHaveBeenCalled();
    expect(t.base.courses).toHaveLength(1);
  });

  it('course confiée à Turbo avec une autre commande : l’autre repart chez Turbo dans une nouvelle course, référence neuve', async () => {
    const t = monterCas({ turbo_escalated_at: ilYa(300) }, [
      { delivery_service: DeliveryService.TURBO },
      { delivery_service: DeliveryService.TURBO },
    ]);

    await t.modifier({ type: OrderType.PICKUP });

    expect(t.A.type).toBe(OrderType.PICKUP);
    expect(t.livraisonDe(t.A)).toBeUndefined();
    expect(t.course.statut).toBe(CourseStatut.CANCELLED);
    const nouvelle = t.base.courses.find((c) => c.id !== t.course.id)!;
    expect(nouvelle.reference).not.toBe('CRS-1');
    expect(t.livraisonDe(t.B)).toEqual(expect.objectContaining({ course_id: nouvelle.id, statut: DeliveryStatut.PENDING }));
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledWith(expect.objectContaining({ courseId: nouvelle.id }));
  });

  it('Turbo refuse l’annulation (livreur Turbo déjà engagé) : refus en clair, rien n’est écrit', async () => {
    const t = monterCas({ turbo_escalated_at: ilYa(300) }, [{ delivery_service: DeliveryService.TURBO }]);
    t.turbo.annulerCourseGroupe.mockResolvedValue({ ok: false, courierAssigned: true });

    await expect(t.modifier({ type: OrderType.PICKUP })).rejects.toThrow(
      new ConflictException(messageLivreurTurboEngage(OrderType.PICKUP)),
    );
    expect(t.A.type).toBe(OrderType.DELIVERY);
    expect(t.livraisonDe(t.A)).toBeDefined();
    expect(t.course.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });

  it('livreur Turbo déjà affecté (connu par ses webhooks) : refus sans même appeler Turbo', async () => {
    const t = monterCas({ turbo_escalated_at: ilYa(300) }, [{ delivery_service: DeliveryService.TURBO }], {
      livraisons: [{ turbo_courier_id: 'turbo-7' }],
    });

    await expect(t.modifier({ type: OrderType.PICKUP })).rejects.toThrow(
      new ConflictException(messageLivreurTurboEngage(OrderType.PICKUP)),
    );
    expect(t.turbo.annulerCourseGroupe).not.toHaveBeenCalled();
    expect(t.A.type).toBe(OrderType.DELIVERY);
  });

  it('groupe annulé chez Turbo puis commande changée entre-temps : refus, et la course est relancée', async () => {
    const t = monterCas({ turbo_escalated_at: ilYa(300) }, [
      { delivery_service: DeliveryService.TURBO },
      { delivery_service: DeliveryService.TURBO },
    ]);
    // Un collègue annule la commande pendant que Turbo répond.
    t.turbo.annulerCourseGroupe.mockImplementation(async () => {
      t.A.status = OrderStatus.CANCELLED;
      return { ok: true };
    });

    await expect(t.modifier({ type: OrderType.PICKUP })).rejects.toThrow(ConflictException);
    expect(t.A.type).toBe(OrderType.DELIVERY);
    // Leur groupe est mort : jamais de course laissée sans livreur chez Turbo.
    expect(t.course).toEqual(
      expect.objectContaining({ statut: CourseStatut.CANCELLED, cancelled_reason: RAISON_TURBO_SANS_CHANGEMENT }),
    );
    const nouvelle = t.base.courses.find((c) => c.id !== t.course.id)!;
    expect(t.livraisonDe(t.B)?.course_id).toBe(nouvelle.id);
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledWith(expect.objectContaining({ courseId: nouvelle.id }));
  });

  it('à emporter vers à livrer : rien de nouveau, la commande attend le planificateur', async () => {
    const t = monterCas({}, [{ type: OrderType.PICKUP }]);
    // Pas encore de livraison pour une commande à emporter.
    t.base.livraisons.splice(0);

    await t.modifier({ type: OrderType.DELIVERY });

    expect(t.A.type).toBe(OrderType.DELIVERY);
    expect(t.base.prisma.delivery.deleteMany).not.toHaveBeenCalled();
    expect(t.emis).toEqual([]);
  });
});
