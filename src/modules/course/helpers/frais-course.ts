import type { Prisma } from '@prisma/client';

import { fraisLivraisonCourse } from './remise-course.rules';

/** Le client Prisma (ou une transaction) : seules ces deux tables servent. */
type ClientFrais = {
  delivery: Pick<Prisma.TransactionClient['delivery'], 'findMany'>;
  course: Pick<Prisma.TransactionClient['course'], 'update'>;
};

/**
 * Recalcule `Course.total_delivery_fee` d'après ses livraisons non annulées.
 * À appeler après tout déplacement de livraison (rééquilibrage, commandes
 * détachées et relancées) : le revenu des courses terminées en dépend.
 *
 * @returns le nouveau total.
 */
export async function recalculerFraisCourse(prisma: ClientFrais, courseId: string): Promise<number> {
  const livraisons = await prisma.delivery.findMany({
    where: { course_id: courseId },
    select: { statut: true, order: { select: { delivery_fee: true } } },
  });
  const total = fraisLivraisonCourse(livraisons);
  await prisma.course.update({ where: { id: courseId }, data: { total_delivery_fee: total } });
  return total;
}
