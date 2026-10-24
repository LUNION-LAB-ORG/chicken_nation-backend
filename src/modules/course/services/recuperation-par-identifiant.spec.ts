/**
 * RÉCUPÉRATION CONFIRMÉE SANS CODE (conception du 24/10, 11.1) : la caissière
 * touche le groupe de la course et confirme ; le livreur lui a dit son code.
 *
 *   GET  /courses/operations/:id               aperçu
 *   POST /courses/operations/:id/recuperation  { order_ids }
 *
 * De bout en bout depuis le contrôleur, compte connecté lu dans `req.user`,
 * avec les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts) :
 * même règle « à remettre » et même cœur de remise que le code de retrait.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CourseStatut, OrderStatus, UserRole, UserType } from '@prisma/client';

import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { CourseOperationsController } from '../controllers/course-operations.controller';
import { ConfirmerRecuperationDto } from '../dto/confirmer-recuperation.dto';
import { CourseChannels } from '../enums/course-channels';
import { MESSAGE_SANS_RESTAURANT, messageCommandesPasPretes } from '../helpers/code-retrait.rules';
import { MESSAGE_RIEN_A_REMETTRE } from '../helpers/depart.rules';
import {
  MESSAGE_COURSE_AUTRE_RESTAURANT,
  MESSAGE_COURSE_CHANGEE,
  MESSAGE_COURSE_INTROUVABLE,
  MESSAGE_COURSE_SANS_LIVREUR,
} from '../helpers/recuperation.rules';
import { AU_COMPTOIR, B, MAINTENANT, avant, monter, prete } from './banc-planificateur.simulee-spec';
import { DonneesDispatch, course, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';

const AUTRE_RESTO = 'resto-marcory';

const CAISSIERE = { id: 'caissiere', role: UserRole.CAISSIER, type: UserType.RESTAURANT, restaurant_id: RESTO };
const MANAGER_AUTRE = { id: 'manager-marcory', role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: AUTRE_RESTO };
const SANS_RESTAURANT = { id: 'assistant', role: UserRole.ASSISTANT_MANAGER, type: UserType.RESTAURANT, restaurant_id: null };
const ADMIN = { id: 'admin', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null };

const req = (user: unknown) => ({ user }) as never;

/** Le rejet d'une promesse : sa classe et son message. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

/** Koffi au comptoir, sa course K au restaurant avec A et B (statuts au choix). */
function auComptoir(statuts: OrderStatus[] = [OrderStatus.READY, OrderStatus.READY], surchargeCourse: Record<string, unknown> = {}) {
  const koffi = livreur({ ...AU_COMPTOIR, last_available_at: null });
  const commandes = statuts.map((status, i) => prete({ status, ...(i === 1 ? { address: B } : {}) }));
  const k = course({
    statut: CourseStatut.AT_RESTAURANT,
    deliverer_id: koffi.id,
    assigned_at: avant(400),
    at_restaurant_at: avant(120),
    created_at: avant(600),
    ...surchargeCourse,
  });
  const donnees: DonneesDispatch = {
    commandes,
    courses: [k],
    livraisons: commandes.map((o, i) => livraison({ course_id: k.id, order_id: o.id, sequence_order: i + 1 })),
    livreurs: [koffi],
  };
  const t = monter(donnees);
  jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);
  const controleur = new CourseOperationsController(t.requetes, t.actions);
  return { koffi, commandes, k, t, controleur };
}

const evenementsStatut = (t: ReturnType<typeof monter>) => t.emisSur(CourseChannels.COURSE_STATUT_CHANGED);

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('aperçu par identifiant (GET /courses/operations/:id)', () => {
  it('la course à remettre, avec ses commandes et son livreur, sans code saisi', async () => {
    const { controleur, k, commandes, koffi } = auComptoir();
    const apercu: any = await controleur.apercuParId(req(CAISSIERE), k.id);
    expect(apercu.id).toBe(k.id);
    expect(apercu.pickup_code).toBe(k.pickup_code);
    expect(apercu.deliverer.id).toBe(koffi.id);
    expect(apercu.deliveries.map((l: any) => l.order.id)).toEqual(commandes.map((o) => o.id));
  });

  it('course inconnue ou d’un autre jour : 404 « Course introuvable. »', async () => {
    const { controleur } = auComptoir();
    expect(await refus(controleur.apercuParId(req(CAISSIERE), 'course-inconnue'))).toEqual({
      classe: NotFoundException,
      message: MESSAGE_COURSE_INTROUVABLE,
    });
    const hier = auComptoir(undefined, { created_at: new Date('2026-10-21T20:00:00.000Z') });
    expect(await refus(hier.controleur.apercuParId(req(CAISSIERE), hier.k.id))).toEqual({
      classe: NotFoundException,
      message: MESSAGE_COURSE_INTROUVABLE,
    });
  });

  it('encore en recherche, sans livreur ni Turbo : 409, personne à qui remettre', async () => {
    const { controleur, k } = auComptoir(undefined, { statut: CourseStatut.PENDING_ASSIGNMENT, deliverer_id: null });
    expect(await refus(controleur.apercuParId(req(CAISSIERE), k.id))).toEqual({
      classe: ConflictException,
      message: MESSAGE_COURSE_SANS_LIVREUR,
    });
  });
});

describe('qui confirme la récupération (garde des rôles, conception 4.1)', () => {
  const passe = (methode: string, role: UserRole) =>
    new UserRolesGuard(new Reflector()).canActivate({
      getHandler: () => (CourseOperationsController.prototype as unknown as Record<string, unknown>)[methode],
      getClass: () => CourseOperationsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as never);
  const AUTORISES: UserRole[] = [UserRole.ADMIN, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER];

  it('les rôles du restaurant et l’ADMIN, comme la route à code ; ni le suivi des livraisons, ni le centre d’appels, ni la cuisine', () => {
    for (const methode of ['apercuParId', 'confirmerRecuperation', 'validatePickup']) {
      for (const role of Object.values(UserRole)) {
        expect([methode, role, passe(methode, role)]).toEqual([methode, role, AUTORISES.includes(role)]);
      }
    }
  });
});

describe('cloisonnement au restaurant de la course', () => {
  it('manager d’un autre restaurant : 403 sur l’aperçu et sur la confirmation, rien ne bouge', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    const attendu = { classe: ForbiddenException, message: MESSAGE_COURSE_AUTRE_RESTAURANT };
    expect(await refus(controleur.apercuParId(req(MANAGER_AUTRE), k.id))).toEqual(attendu);
    expect(
      await refus(controleur.confirmerRecuperation(req(MANAGER_AUTRE), k.id, { order_ids: commandes.map((o) => o.id) })),
    ).toEqual(attendu);
    expect(k.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.READY, OrderStatus.READY]);
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
  });

  it('la caissière désigne la course d’un autre restaurant : 403', async () => {
    const { controleur, k, commandes } = auComptoir(undefined, { restaurant_id: AUTRE_RESTO });
    expect(await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [commandes[0].id] }))).toEqual({
      classe: ForbiddenException,
      message: MESSAGE_COURSE_AUTRE_RESTAURANT,
    });
    expect(k.statut).toBe(CourseStatut.AT_RESTAURANT);
  });

  it('compte de restaurant sans restaurant rattaché : 403', async () => {
    const { controleur, k } = auComptoir();
    expect(await refus(controleur.apercuParId(req(SANS_RESTAURANT), k.id))).toEqual({
      classe: ForbiddenException,
      message: MESSAGE_SANS_RESTAURANT,
    });
  });

  it('compte du siège : la course de n’importe quel restaurant', async () => {
    const { controleur, k, commandes } = auComptoir(undefined, { restaurant_id: AUTRE_RESTO });
    await controleur.confirmerRecuperation(req(ADMIN), k.id, { order_ids: commandes.map((o) => o.id) });
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
  });
});

describe('confirmation (POST /courses/operations/:id/recuperation)', () => {
  it('livreur au comptoir, deux commandes prêtes : course remise, commandes récupérées, livreur prévenu une fois', async () => {
    const { controleur, k, commandes, koffi, t } = auComptoir();
    const remise: any = await controleur.confirmerRecuperation(req(CAISSIERE), k.id, {
      order_ids: commandes.map((o) => o.id),
    });

    expect(remise.id).toBe(k.id);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(k.picked_up_at).toEqual(MAINTENANT);
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.PICKED_UP, OrderStatus.PICKED_UP]);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledWith({
      delivererId: koffi.id,
      courseReference: k.reference,
      courseId: k.id,
    });
    expect(evenementsStatut(t)).toHaveLength(1);
  });

  it('une commande pas encore prête : refus actuel qui la nomme, rien ne bouge', async () => {
    const { controleur, k, commandes, t } = auComptoir([OrderStatus.READY, OrderStatus.IN_PROGRESS]);
    expect(
      await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [commandes[0].id] })),
    ).toEqual({
      classe: BadRequestException,
      message: messageCommandesPasPretes([{ reference: commandes[1].reference, status: OrderStatus.IN_PROGRESS }]),
    });
    expect(k.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect(commandes[0].status).toBe(OrderStatus.READY);
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
  });

  it('une commande qui n’est pas (ou plus) dans la course : 409, la caissière relit la fenêtre', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    const [a, b] = commandes;
    // Commande prête d'une autre course du restaurant (même tableau que la base).
    const ailleurs = prete();
    t.base.commandes.push(ailleurs);
    for (const order_ids of [[a.id, ailleurs.id], ['commande-inconnue']]) {
      expect(await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids }))).toEqual({
        classe: ConflictException,
        message: MESSAGE_COURSE_CHANGEE,
      });
    }
    expect(k.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect([a.status, b.status, ailleurs.status]).toEqual([OrderStatus.READY, OrderStatus.READY, OrderStatus.READY]);
  });

  it('confirmée deux fois (deux postes, ou deux touchers) : la seconde reçoit 409, le livreur n’est prévenu qu’une fois', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    const corps = { order_ids: commandes.map((o) => o.id) };

    await controleur.confirmerRecuperation(req(CAISSIERE), k.id, corps);
    expect(await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, corps))).toEqual({
      classe: ConflictException,
      message: "Cette course vient d'être remise au livreur.",
    });
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
  });

  it('deux confirmations au même instant : une seule remise, l’autre 409', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    const corps = { order_ids: commandes.map((o) => o.id) };
    const issues = await Promise.allSettled([
      controleur.confirmerRecuperation(req(CAISSIERE), k.id, corps),
      controleur.confirmerRecuperation(req(ADMIN), k.id, corps),
    ]);
    expect(issues.filter((i) => i.status === 'fulfilled')).toHaveLength(1);
    const [echec] = issues.filter((i): i is PromiseRejectedResult => i.status === 'rejected');
    expect(echec.reason).toBeInstanceOf(ConflictException);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('commande prête arrivée dans la course après l’ouverture de la fenêtre : seules les commandes confirmées partent', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    await controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [commandes[0].id] });

    expect(commandes[0].status).toBe(OrderStatus.PICKED_UP);
    expect(commandes[1].status).toBe(OrderStatus.READY);
    // Remise ensuite avec le même code, ou retirée de la course au départ du livreur.
    const ajout = t.base.livraisons.find((l) => l.order_id === commandes[1].id)!;
    expect(ajout.ajoutee_apres_retrait).toBe(true);
  });

  it('course confiée à Turbo, encore en recherche chez eux : la remise passe', async () => {
    const { controleur, k, commandes } = auComptoir(undefined, {
      statut: CourseStatut.PENDING_ASSIGNMENT,
      deliverer_id: null,
      turbo_escalated_at: avant(300),
    });
    await controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: commandes.map((o) => o.id) });
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.PICKED_UP, OrderStatus.PICKED_UP]);
  });
});

describe('retrait complémentaire par identifiant (livreur encore au restaurant)', () => {
  /** K récupérée (A remise), livreur au comptoir, C prête ajoutée après le retrait. */
  function avecAjoutPret() {
    const koffi = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60) });
    const c = prete({ address: B, ready_at: avant(10) });
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: koffi.id,
      assigned_at: avant(400),
      at_restaurant_at: avant(300),
      picked_up_at: avant(60),
      created_at: avant(600),
    });
    const t = monter({
      commandes: [a, c],
      courses: [k],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(10), ajoutee_apres_retrait: true }),
      ],
      livreurs: [koffi],
    });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);
    return { koffi, a, c, k, t, controleur: new CourseOperationsController(t.requetes, t.actions) };
  }

  it('la commande ajoutée est remise, la course reste en livraison, journal du retrait complémentaire', async () => {
    const { controleur, c, k, t } = avecAjoutPret();
    await controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [c.id] });
    expect(c.status).toBe(OrderStatus.PICKED_UP);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE').at(-1)!.details).toMatchObject({ commandes: [c.reference] });
  });

  it('confirmée deux fois : la seconde reçoit 409, rien n’est remis deux fois', async () => {
    const { controleur, c, k } = avecAjoutPret();
    await controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [c.id] });
    const second = await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [c.id] }));
    expect(second.classe).toBe(ConflictException);
  });

  it('commande déjà remise confirmée seule : rien à remettre, 409', async () => {
    const { controleur, a, k, t } = avecAjoutPret();
    expect(await refus(controleur.confirmerRecuperation(req(CAISSIERE), k.id, { order_ids: [a.id] }))).toEqual({
      classe: ConflictException,
      message: MESSAGE_RIEN_A_REMETTRE,
    });
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE')).toHaveLength(0);
  });
});

describe('route à code inchangée (caisse Sunmi, repli de l’écran)', () => {
  it('le code remet toutes les commandes lues, comme avant', async () => {
    const { controleur, k, commandes, t } = auComptoir();
    await controleur.validatePickup(req(CAISSIERE), { pickup_code: k.pickup_code } as never);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.PICKED_UP, OrderStatus.PICKED_UP]);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
  });
});

describe('corps de la confirmation', () => {
  const erreurs = async (corps: unknown) =>
    (await validate(plainToInstance(ConfirmerRecuperationDto, corps))).flatMap((e) => Object.values(e.constraints ?? {}));

  it('au moins une commande, chacune par son identifiant', async () => {
    expect(await erreurs({ order_ids: ['7b0c2f1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b'] })).toEqual([]);
    expect(await erreurs({ order_ids: [] })).toEqual(['Choisissez au moins une commande.']);
    expect(await erreurs({})).toContain('Choisissez au moins une commande.');
    expect(await erreurs({ order_ids: ['ORD-4821'] })).toEqual(['Commande inconnue.']);
  });
});
