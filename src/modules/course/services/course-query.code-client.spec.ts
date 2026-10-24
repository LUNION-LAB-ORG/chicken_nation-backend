/**
 * Code client des livraisons (`delivery_pin`) dans la liste et le détail des
 * courses (conception du 24/10, 11.7) : l'ADMIN seulement (support : client
 * qui a perdu son code). Le suivi des livraisons (LIVRAISON_OPS), qui ouvre
 * aussi ces deux routes, lit le reste sans lui : avec ce code, on valide une
 * livraison sans voir le client.
 */
import { UserRole, UserType } from '@prisma/client';

import { CourseAdminController } from '../controllers/course-admin.controller';
import { COURSE_ADMIN_INCLUDE, COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { CourseQueryService, includeCoursePour } from './course-query.service';

const ADMIN = { id: 'admin', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null };
const SUIVI = { id: 'suivi', role: UserRole.LIVRAISON_OPS, type: UserType.BACKOFFICE, restaurant_id: null };

function monter() {
  const prisma = {
    course: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({ id: 'k' }),
    },
  };
  const service = new CourseQueryService(prisma as never);
  const controleur = new CourseAdminController(service, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { prisma, controleur };
}

const omisDuDetail = (args: any) => args.include.deliveries.omit;

describe('code client des livraisons : ADMIN seulement', () => {
  it('règle : ADMIN, l’include avec le code ; tout autre compte, ou aucun, sans lui', () => {
    expect(includeCoursePour(ADMIN)).toBe(COURSE_ADMIN_INCLUDE);
    expect(includeCoursePour(SUIVI)).toBe(COURSE_FULL_INCLUDE);
    expect(includeCoursePour(undefined)).toBe(COURSE_FULL_INCLUDE);
    expect(COURSE_FULL_INCLUDE.deliveries.omit).toEqual({ delivery_pin: true });
    expect(COURSE_ADMIN_INCLUDE.deliveries.omit).toEqual({ delivery_pin: false });
  });

  it('GET /courses : lu pour l’ADMIN, omis pour LIVRAISON_OPS', async () => {
    const { prisma, controleur } = monter();
    await controleur.findAll({ user: ADMIN } as never, {} as never);
    await controleur.findAll({ user: SUIVI } as never, {} as never);
    expect(omisDuDetail(prisma.course.findMany.mock.calls[0][0])).toEqual({ delivery_pin: false });
    expect(omisDuDetail(prisma.course.findMany.mock.calls[1][0])).toEqual({ delivery_pin: true });
  });

  it('GET /courses/:id : lu pour l’ADMIN, omis pour LIVRAISON_OPS ; tentatives d’affectation toujours lues', async () => {
    const { prisma, controleur } = monter();
    await controleur.findOne({ user: ADMIN } as never, 'k');
    await controleur.findOne({ user: SUIVI } as never, 'k');
    const [admin, suivi] = prisma.course.findUnique.mock.calls.map((c) => c[0]);
    expect(omisDuDetail(admin)).toEqual({ delivery_pin: false });
    expect(omisDuDetail(suivi)).toEqual({ delivery_pin: true });
    expect(suivi.include.offer_attempts).toBeDefined();
  });
});
