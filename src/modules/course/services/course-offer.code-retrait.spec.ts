/**
 * Génération du code de retrait à la création d'une course : unique dans le
 * restaurant pour la journée de service, tiré sous le verrou consultatif du
 * restaurant, dans la transaction qui crée la course.
 *
 * La base en mémoire imite PostgreSQL sur ce qui compte ici : les `where`
 * sont évalués (`correspond`), une transaction ne publie ses courses qu'à sa
 * validation, et `pg_advisory_xact_lock` fait attendre la transaction
 * suivante jusqu'à la fin de celle qui le tient. Tirer le code hors de la
 * transaction, ou sans le verrou, donne le même code à deux créations
 * simultanées : le test casse.
 */
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { correspond } from 'src/modules/order/relance/relance.base-simulee-spec';

import { TOUS_LES_CODES_RETRAIT } from '../helpers/code-retrait.rules';
import { CLASSE_VERROU_CODE_RETRAIT, CourseHelper } from '../helpers/course.helper';
import { journeeDeService } from '../helpers/journee-service.rules';
import { CourseOfferService } from './course-offer.service';

const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const { debut } = journeeDeService(new Date());
const ceMatin = new Date(debut.getTime() + 20 * 60_000);
const hierSoir = new Date(debut.getTime() - 2 * 60 * 60_000);

type Ligne = Record<string, any>;

let numero = 0;
const existante = (restaurant_id: string, pickup_code: string, statut: CourseStatut, created_at: Date): Ligne => ({
  id: `existante-${++numero}`,
  reference: `CRS-EX-${numero}`,
  restaurant_id,
  pickup_code,
  statut,
  created_at,
});

function monterBase(existantes: Ligne[]) {
  const courses: Ligne[] = [...existantes];
  const verrous = new Map<string, Promise<void>>();
  const verrousPris: unknown[][] = [];

  const lireCourses = async ({ where, select }: Ligne) =>
    courses
      .filter((c) => correspond(c, where))
      .map((c) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, c[k]])) : c));

  async function transaction(fn: (tx: Ligne) => Promise<unknown>) {
    const aPublier: Ligne[] = [];
    let liberer: (() => void) | undefined;
    const tx = {
      // pg_advisory_xact_lock : attend la fin de la transaction qui tient la même clé.
      $executeRaw: async (_sql: TemplateStringsArray, ...valeurs: unknown[]) => {
        verrousPris.push(valeurs);
        const cle = valeurs.join(':');
        const precedent = verrous.get(cle) ?? Promise.resolve();
        const tenu = new Promise<void>((r) => (liberer = r));
        verrous.set(cle, precedent.then(() => tenu));
        await precedent;
        return 1;
      },
      course: {
        // Une transaction ne voit que ce qui est validé (READ COMMITTED).
        findMany: lireCourses,
        create: async ({ data }: Ligne) => {
          const { deliveries: _livraisons, ...colonnes } = data;
          const ligne = { id: `nouvelle-${++numero}`, created_at: new Date(), ...colonnes };
          aPublier.push(ligne);
          return ligne;
        },
      },
      delivery: {
        updateMany: async () => ({ count: 1 }),
      },
    };
    try {
      const resultat = await fn(tx);
      courses.push(...aPublier);
      return resultat;
    } finally {
      liberer?.();
    }
  }

  return { courses, verrousPris, transaction, lireCourses };
}

function monterService(existantes: Ligne[], prismaEnPlus: Ligne = {}) {
  const base = monterBase(existantes);
  const prisma = {
    order: {
      findMany: jest.fn(async () => [
        {
          id: `commande-${++numero}`,
          delivery_fee: 1000,
          address: null,
          delivery_service: DeliveryService.CHICKEN_NATION,
          recovery_code: '1234',
        },
      ]),
    },
    delivery: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn((fn: (tx: Ligne) => Promise<unknown>) => base.transaction(fn)),
    ...prismaEnPlus,
  };
  const helper = new CourseHelper();
  const service = new CourseOfferService(
    prisma as never,
    {} as never,
    helper,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // Appli du livreur : sans objet ici (création de course, code de retrait).
    {} as never,
  );
  jest.spyOn(service, 'offerNextDeliverer').mockResolvedValue(undefined);
  return { service, helper, prisma, ...base };
}

afterEach(() => jest.restoreAllMocks());

describe('Code de retrait à la création de la course', () => {
  it('deux créations simultanées pour le même restaurant : deux codes différents, tirés sous verrou', async () => {
    // Hasard figé : sans verrou, les deux créations tireraient le même premier code libre.
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { service, courses, verrousPris } = monterService([
      existante(RESTO_A, '000', CourseStatut.IN_DELIVERY, ceMatin),
      // Code pris ce matin dans le restaurant, course terminée : reste pris.
      existante(RESTO_A, '001', CourseStatut.COMPLETED, ceMatin),
      // Même code dans un AUTRE restaurant : ne compte pas.
      existante(RESTO_B, '002', CourseStatut.ACCEPTED, ceMatin),
      // Code donné HIER dans le restaurant : redevient libre.
      existante(RESTO_A, '003', CourseStatut.AT_RESTAURANT, hierSoir),
    ]);

    const [c1, c2] = await Promise.all([
      service.createFromReadyOrders({ restaurantId: RESTO_A, orderIds: ['o1'] }),
      service.createFromReadyOrders({ restaurantId: RESTO_A, orderIds: ['o2'] }),
    ]);

    expect([c1.pickup_code, c2.pickup_code]).toEqual(['002', '003']);
    expect(verrousPris).toEqual([
      [CLASSE_VERROU_CODE_RETRAIT, RESTO_A],
      [CLASSE_VERROU_CODE_RETRAIT, RESTO_A],
    ]);
    const duJourA = courses.filter((c) => c.restaurant_id === RESTO_A && c.created_at >= debut);
    expect(new Set(duJourA.map((c) => c.pickup_code)).size).toBe(duJourA.length);
  });

  it('cent courses dans la journée d\'un restaurant : aucun code en double', async () => {
    const { service, courses } = monterService([]);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        service.createFromReadyOrders({ restaurantId: RESTO_A, orderIds: [`o${i}`] }),
      ),
    );
    const codes = courses.map((c) => c.pickup_code);
    expect(codes).toHaveLength(100);
    expect(new Set(codes).size).toBe(100);
    for (const code of codes) expect(code).toMatch(/^\d{3}$/);
  });

  it('les restaurants ne s\'attendent pas : un verrou par restaurant', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { service, verrousPris } = monterService([]);

    const [a, b] = await Promise.all([
      service.createFromReadyOrders({ restaurantId: RESTO_A, orderIds: ['o1'] }),
      service.createFromReadyOrders({ restaurantId: RESTO_B, orderIds: ['o2'] }),
    ]);

    // Chacun son premier code libre : le même, dans deux restaurants différents.
    expect([a.pickup_code, b.pickup_code]).toEqual(['000', '000']);
    expect(verrousPris.map((v) => v[1]).sort()).toEqual([RESTO_A, RESTO_B]);
  });

  it('relance d\'une course annulée : la nouvelle course reçoit un code libre du jour, sous verrou', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const annulee = {
      id: 'annulee',
      reference: 'CRS-ANNULEE',
      statut: CourseStatut.CANCELLED,
      restaurant_id: RESTO_A,
      deliveries: [
        {
          id: 'livraison-1',
          statut: DeliveryStatut.CANCELLED,
          order: {
            id: 'commande-1',
            status: OrderStatus.READY,
            // Lu par la relance : une commande passée à emporter n'est jamais relancée.
            type: OrderType.DELIVERY,
            delivery_fee: 1000,
            delivery_service: DeliveryService.CHICKEN_NATION,
            entity_status: 'ACTIVE',
          },
        },
      ],
    };
    const { service, verrousPris } = monterService(
      [existante(RESTO_A, '000', CourseStatut.CANCELLED, ceMatin)],
      { course: { findUnique: jest.fn(async () => annulee) } },
    );

    const r = await service.relancerCourseAnnulee('annulee');

    expect(r.ok).toBe(true);
    expect(verrousPris).toEqual([[CLASSE_VERROU_CODE_RETRAIT, RESTO_A]]);
  });
});

describe('CourseHelper.genererCodeRetrait', () => {
  it('lit les courses du restaurant de la journée de service, tous statuts confondus', async () => {
    const { lireCourses } = monterBase([]);
    const findMany = jest.fn(lireCourses);
    const tx = { $executeRaw: jest.fn(async () => 1), course: { findMany } };
    const maintenant = new Date('2026-10-22T00:30:00.000Z');

    await new CourseHelper().genererCodeRetrait(tx as never, RESTO_A, maintenant);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        restaurant_id: RESTO_A,
        created_at: {
          gte: new Date('2026-10-21T05:00:00.000Z'),
          lt: new Date('2026-10-22T05:00:00.000Z'),
        },
      },
      select: { pickup_code: true, statut: true },
    });
    // Le verrou est pris AVANT la lecture.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });

  it('les 1 000 codes ont servi : repli sur une course terminée, journalisé', async () => {
    const helper = new CourseHelper();
    const avertir = jest.spyOn((helper as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn').mockImplementation();
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      course: {
        findMany: jest.fn(async () =>
          TOUS_LES_CODES_RETRAIT.map((pickup_code) => ({
            pickup_code,
            statut: pickup_code === '640' ? CourseStatut.COMPLETED : CourseStatut.ACCEPTED,
          })),
        ),
      },
    };

    const code = await helper.genererCodeRetrait(tx as never, RESTO_A);

    expect(code).toBe('640');
    expect(avertir).toHaveBeenCalledTimes(1);
    expect(avertir.mock.calls[0][0]).toContain('repli CODE_DE_COURSE_TERMINEE');
    expect(avertir.mock.calls[0][0]).toContain(RESTO_A);
  });

  it('cas normal : rien n\'est journalisé', async () => {
    const helper = new CourseHelper();
    const avertir = jest.spyOn((helper as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn').mockImplementation();
    const tx = { $executeRaw: jest.fn(async () => 1), course: { findMany: jest.fn(async () => []) } };

    expect(await helper.genererCodeRetrait(tx as never, RESTO_A)).toMatch(/^\d{3}$/);
    expect(avertir).not.toHaveBeenCalled();
  });
});
