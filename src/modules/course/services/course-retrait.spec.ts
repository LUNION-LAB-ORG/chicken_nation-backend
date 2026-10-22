/**
 * Retrait à la caisse par code (aperçu et validation), de bout en bout depuis
 * le contrôleur : le compte connecté est lu dans `req.user`, les services sont
 * RÉELS, la base est en mémoire et ÉVALUE les `where` (`correspond`). Retirer
 * le filtre du restaurant ou de la journée fait casser ces tests.
 *
 * Incident du 22/10 : une course d'un AUTRE restaurant, encore active, portait
 * le même code ; la caisse tombait dessus et refusait le retrait (« 1
 * commande(s) sur 1 ne sont pas encore prête(s) ») alors que la bonne
 * commande était prête.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CourseStatut, OrderStatus, UserRole, UserType } from '@prisma/client';

import { correspond } from 'src/modules/order/relance/relance.base-simulee-spec';

import { CourseOperationsController } from '../controllers/course-operations.controller';
import { ValidatePickupDto } from '../dto/validate-pickup.dto';
import {
  MESSAGE_AUTRE_RESTAURANT,
  MESSAGE_CODE_INTROUVABLE,
  MESSAGE_CODE_PLUSIEURS_RESTAURANTS,
} from '../helpers/code-retrait.rules';
import { journeeDeService } from '../helpers/journee-service.rules';
import { CourseActionService } from './course-action.service';
import { CourseQueryService } from './course-query.service';

const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CAISSIERE_A = { id: 'caissiere-a', role: UserRole.CAISSIER, type: UserType.RESTAURANT, restaurant_id: RESTO_A };
const MANAGER_B = { id: 'manager-b', role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: RESTO_B };
const ADMIN = { id: 'admin', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null };

// Dates relatives à la journée de service EN COURS : le test passe à toute heure.
const { debut } = journeeDeService(new Date());
const ceMatin = (minutes: number) => new Date(debut.getTime() + minutes * 60_000);
const hierSoir = new Date(debut.getTime() - 2 * 60 * 60_000);

type Ligne = Record<string, any>;

function course(id: string, restaurant_id: string, statutsCommandes: OrderStatus[], surcharge: Ligne = {}): Ligne {
  return {
    id,
    reference: `CRS-${id}`,
    pickup_code: '421',
    restaurant_id,
    statut: CourseStatut.ACCEPTED,
    deliverer_id: `livreur-${id}`,
    turbo_escalated_at: null,
    assigned_at: ceMatin(30),
    at_restaurant_at: null,
    picked_up_at: null,
    created_at: ceMatin(20),
    deliveries: statutsCommandes.map((status, i) => ({
      id: `${id}-livraison-${i + 1}`,
      order: { id: `${id}-commande-${i + 1}`, reference: `ORD-${id}-${i + 1}`, status },
    })),
    ...surcharge,
  };
}

function monter(courses: Ligne[]) {
  const prisma = {
    course: {
      findMany: jest.fn(async ({ where, take }: Ligne) =>
        courses.filter((c) => correspond(c, where)).slice(0, take ?? Infinity),
      ),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async ({ where, data }: Ligne) => {
        const c = courses.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      }),
    },
    order: {
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const c = courses.find((x) => x.id === where.delivery.course_id)!;
        for (const d of c.deliveries) Object.assign(d.order, data);
        return { count: c.deliveries.length };
      }),
    },
    restaurant: { findUnique: jest.fn(async () => ({ apikey: 'cle' })) },
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const courseEvent = { courseStatutChanged: jest.fn(async () => undefined) };
  const pushService = { notifyPickupValidated: jest.fn() };
  const turboService = { confirmerRetrait: jest.fn(async () => undefined) };
  const maps = { getDirections: jest.fn(async () => null) };

  const queryService = new CourseQueryService(prisma as never);
  const actionService = new CourseActionService(
    prisma as never,
    courseEvent as never,
    {} as never,
    {} as never,
    pushService as never,
    turboService as never,
    maps as never,
    queryService,
    {} as never,
  );
  const controleur = new CourseOperationsController(queryService, actionService);
  return { controleur, prisma, courseEvent, pushService, turboService };
}

const req = (user: unknown) => ({ user }) as never;

/** Le rejet d'une promesse, avec sa classe et son message. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

describe('Retrait par code : aperçu et validation', () => {
  it('incident du 22/10 : la caissière de A valide SA course, celle de B (même code, pas prête) est ignorée', async () => {
    const a = course('a', RESTO_A, [OrderStatus.READY], { assigned_at: ceMatin(30) });
    // Assignée plus tard : l'ancienne recherche (la plus récente du réseau) la prenait.
    const b = course('b', RESTO_B, [OrderStatus.IN_PROGRESS], {
      statut: CourseStatut.AT_RESTAURANT,
      assigned_at: ceMatin(45),
    });
    const { controleur, courseEvent, pushService } = monter([a, b]);

    // La caisse Sunmi n'envoie que le code.
    const validee = await controleur.validatePickup(req(CAISSIERE_A), { pickup_code: '421' } as ValidatePickupDto);

    expect(validee.id).toBe('a');
    expect(a.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(a.deliveries[0].order.status).toBe(OrderStatus.PICKED_UP);
    expect(b.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect(b.deliveries[0].order.status).toBe(OrderStatus.IN_PROGRESS);
    expect(courseEvent.courseStatutChanged).toHaveBeenCalledTimes(1);
    expect(pushService.notifyPickupValidated).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: 'livreur-a' }),
    );
  });

  it('aperçu de la caissière : la course de son restaurant, sans rien envoyer', async () => {
    const a = course('a', RESTO_A, [OrderStatus.READY]);
    const b = course('b', RESTO_B, [OrderStatus.READY], { assigned_at: ceMatin(50) });
    const { controleur } = monter([a, b]);

    expect((await controleur.getByPickupCode(req(CAISSIERE_A), '421', {})).id).toBe('a');
    expect((await controleur.getByPickupCode(req(MANAGER_B), '421', {})).id).toBe('b');
  });

  it("course d'hier encore active dans le restaurant : ignorée", async () => {
    const hier = course('hier', RESTO_A, [OrderStatus.READY], { created_at: hierSoir, assigned_at: hierSoir });
    const { controleur, prisma } = monter([hier]);

    const r = await refus(controleur.validatePickup(req(CAISSIERE_A), { pickup_code: '421' } as ValidatePickupDto));
    expect(r).toEqual({ classe: NotFoundException, message: MESSAGE_CODE_INTROUVABLE });
    expect(prisma.course.update).not.toHaveBeenCalled();

    // Le même code, redonné aujourd'hui à une nouvelle course : c'est elle.
    const { controleur: c2 } = monter([hier, course('aujourdhui', RESTO_A, [OrderStatus.READY])]);
    expect((await c2.getByPickupCode(req(CAISSIERE_A), '421', {})).id).toBe('aujourdhui');
  });

  it('caissière qui envoie un autre restaurant : 403, rien n\'est écrit', async () => {
    const b = course('b', RESTO_B, [OrderStatus.READY]);
    const { controleur, prisma } = monter([b]);

    const apercu = await refus(controleur.getByPickupCode(req(CAISSIERE_A), '421', { restaurant_id: RESTO_B }));
    const validation = await refus(
      controleur.validatePickup(req(CAISSIERE_A), { pickup_code: '421', restaurant_id: RESTO_B } as ValidatePickupDto),
    );

    expect(apercu).toEqual({ classe: ForbiddenException, message: MESSAGE_AUTRE_RESTAURANT });
    expect(validation).toEqual({ classe: ForbiddenException, message: MESSAGE_AUTRE_RESTAURANT });
    expect(prisma.course.findMany).not.toHaveBeenCalled();
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('admin avec restaurant_id : la course de ce restaurant', async () => {
    const a = course('a', RESTO_A, [OrderStatus.READY]);
    const b = course('b', RESTO_B, [OrderStatus.READY]);
    const { controleur } = monter([a, b]);

    expect((await controleur.getByPickupCode(req(ADMIN), '421', { restaurant_id: RESTO_B })).id).toBe('b');
    const validee = await controleur.validatePickup(req(ADMIN), {
      pickup_code: '421',
      restaurant_id: RESTO_B,
    } as ValidatePickupDto);
    expect(validee.id).toBe('b');
    expect(a.statut).toBe(CourseStatut.ACCEPTED);
  });

  it('admin sans restaurant_id : 409 si le code existe dans plusieurs restaurants, rien n\'est écrit', async () => {
    const a = course('a', RESTO_A, [OrderStatus.READY]);
    const b = course('b', RESTO_B, [OrderStatus.READY]);
    const { controleur, prisma } = monter([a, b]);

    const apercu = await refus(controleur.getByPickupCode(req(ADMIN), '421', {}));
    const validation = await refus(controleur.validatePickup(req(ADMIN), { pickup_code: '421' } as ValidatePickupDto));

    expect(apercu).toEqual({ classe: ConflictException, message: MESSAGE_CODE_PLUSIEURS_RESTAURANTS });
    expect(validation).toEqual({ classe: ConflictException, message: MESSAGE_CODE_PLUSIEURS_RESTAURANTS });
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('admin sans restaurant_id : un seul restaurant a ce code aujourd\'hui, la course est trouvée', async () => {
    const b = course('b', RESTO_B, [OrderStatus.READY]);
    // Même code chez A, mais hier : ne compte pas.
    const hierA = course('hier-a', RESTO_A, [OrderStatus.READY], { created_at: hierSoir });
    const { controleur } = monter([b, hierA]);

    const validee = await controleur.validatePickup(req(ADMIN), { pickup_code: '421' } as ValidatePickupDto);
    expect(validee.id).toBe('b');
  });

  it('commande pas prête : 400 qui nomme la commande et son statut, rien n\'est écrit', async () => {
    const a = course('a', RESTO_A, [OrderStatus.READY, OrderStatus.IN_PROGRESS]);
    const { controleur, prisma } = monter([a]);

    const r = await refus(controleur.validatePickup(req(CAISSIERE_A), { pickup_code: '421' } as ValidatePickupDto));

    expect(r).toEqual({
      classe: BadRequestException,
      message: 'La commande ORD-a-2 est encore « En préparation » : marquez-la prête avant de la remettre.',
    });
    expect(prisma.course.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('course confiée à Turbo, encore en attente chez eux : l\'aperçu et la validation la trouvent', async () => {
    const turbo = course('turbo', RESTO_A, [OrderStatus.READY], {
      statut: CourseStatut.PENDING_ASSIGNMENT,
      deliverer_id: null,
      assigned_at: null,
      turbo_escalated_at: ceMatin(25),
    });
    const interne = course('interne', RESTO_A, [OrderStatus.READY], {
      pickup_code: '777',
      statut: CourseStatut.PENDING_ASSIGNMENT,
      deliverer_id: null,
      assigned_at: null,
    });
    const { controleur, turboService } = monter([turbo, interne]);

    expect((await controleur.getByPickupCode(req(CAISSIERE_A), '421', {})).id).toBe('turbo');
    await controleur.validatePickup(req(CAISSIERE_A), { pickup_code: '421' } as ValidatePickupDto);
    expect(turbo.statut).toBe(CourseStatut.IN_DELIVERY);
    await new Promise((r) => setImmediate(r));
    expect(turboService.confirmerRetrait).toHaveBeenCalledWith(
      expect.objectContaining({ referenceCourse: 'CRS-turbo', restaurantId: RESTO_A }),
    );

    // Course interne sans livreur : rien à remettre.
    const r = await refus(controleur.getByPickupCode(req(CAISSIERE_A), '777', {}));
    expect(r.classe).toBe(NotFoundException);
  });
});

describe('ValidatePickupDto', () => {
  const erreurs = async (corps: unknown) =>
    (await validate(plainToInstance(ValidatePickupDto, corps))).flatMap((e) => Object.values(e.constraints ?? {}));

  it('restaurant_id facultatif : la caisse Sunmi n\'envoie que le code', async () => {
    expect(await erreurs({ pickup_code: '421' })).toEqual([]);
  });

  it('restaurant_id vide : traité comme absent', async () => {
    const dto = plainToInstance(ValidatePickupDto, { pickup_code: '421', restaurant_id: '' });
    expect(dto.restaurant_id).toBeUndefined();
    expect(await validate(dto)).toEqual([]);
  });

  it('restaurant_id qui n\'est pas un identifiant : refusé', async () => {
    expect(await erreurs({ pickup_code: '421', restaurant_id: 'resto-a' })).toEqual(['Restaurant inconnu.']);
    expect(await erreurs({ pickup_code: '421', restaurant_id: RESTO_A })).toEqual([]);
  });
});
