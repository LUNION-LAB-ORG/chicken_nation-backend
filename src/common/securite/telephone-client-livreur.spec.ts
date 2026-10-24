import { CourseStatut, DeliveryStatut } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { CourseDelivererController } from 'src/modules/course/controllers/course-deliverer.controller';
import { sansTelephoneClientTermine, telephoneClientVisible } from './telephone-client-livreur';
import { TelephoneClientLivreurInterceptor } from './telephone-client-livreur.interceptor';

/**
 * Numéro du client chez le livreur : présent pendant la course, `null` dès
 * que la livraison est terminée ou la course close.
 */

type Commande = {
  id: string;
  phone: string | null;
  fullname: string;
  customer: { id: string; first_name: string; phone: string | null } | null;
};
type Livraison = { id: string; statut: string; order: Commande };
type Course = { id: string; statut: string; picked_up_at: Date; deliveries: Livraison[]; deliverer: { phone: string } };

let numero = 0;
function livraison(statut: DeliveryStatut): Livraison {
  numero += 1;
  return {
    id: `l${numero}`,
    statut,
    order: {
      id: `o${numero}`,
      phone: `+22507000000${numero}`,
      fullname: 'Awa Koné',
      customer: { id: `c${numero}`, first_name: 'Awa', phone: `+22501000000${numero}` },
    },
  };
}

function course(statut: CourseStatut, ...livraisons: Livraison[]): Course {
  return {
    id: 'k1',
    statut,
    picked_up_at: new Date('2026-10-24T10:00:00.000Z'),
    deliveries: livraisons,
    deliverer: { phone: '+2250500000000' },
  };
}

const numeros = (k: Course) => k.deliveries.map((l) => [l.order.phone, l.order.customer?.phone ?? null]);

describe('numéro du client chez le livreur', () => {
  describe('telephoneClientVisible', () => {
    it('visible pendant la course, pour une livraison pas encore finie', () => {
      for (const statutCourse of [CourseStatut.PENDING_ASSIGNMENT, CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY]) {
        for (const statut of [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED]) {
          expect(telephoneClientVisible(statutCourse, statut)).toBe(true);
        }
      }
    });

    it('caché pour une livraison terminée, même dans une course en cours', () => {
      for (const statut of [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED]) {
        expect(telephoneClientVisible(CourseStatut.IN_DELIVERY, statut)).toBe(false);
      }
    });

    it('caché pour toute livraison d\'une course close', () => {
      for (const statutCourse of [CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED]) {
        expect(telephoneClientVisible(statutCourse, DeliveryStatut.IN_ROUTE)).toBe(false);
        expect(telephoneClientVisible(statutCourse, null)).toBe(false);
      }
    });
  });

  describe('sansTelephoneClientTermine', () => {
    it('course en cours : les numéros restent, la charge ressort telle quelle', () => {
      const k = course(CourseStatut.IN_DELIVERY, livraison(DeliveryStatut.IN_ROUTE), livraison(DeliveryStatut.PENDING));
      const avant = numeros(k);
      const r = sansTelephoneClientTermine(k);
      expect(r).toBe(k);
      expect(numeros(r)).toEqual(avant);
    });

    it.each([CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED])(
      'course %s : plus aucun numéro du client, rien d\'autre ne change',
      (statut) => {
        const k = course(statut, livraison(DeliveryStatut.DELIVERED), livraison(DeliveryStatut.FAILED), livraison(DeliveryStatut.IN_ROUTE));
        const r = sansTelephoneClientTermine(k);
        expect(numeros(r)).toEqual([[null, null], [null, null], [null, null]]);
        expect(r.deliveries[0].order.fullname).toBe('Awa Koné');
        expect(r.deliveries[0].order.customer?.first_name).toBe('Awa');
        expect(r.deliverer.phone).toBe('+2250500000000');
        expect(r.picked_up_at).toBe(k.picked_up_at);
        expect(JSON.stringify(r)).not.toMatch(/\+22507|\+22501/);
      },
    );

    it('livraison terminée dans une course en cours : absent pour cet arrêt, présent pour les autres', () => {
      const livree = livraison(DeliveryStatut.DELIVERED);
      const echouee = livraison(DeliveryStatut.FAILED);
      const annulee = livraison(DeliveryStatut.CANCELLED);
      const enRoute = livraison(DeliveryStatut.IN_ROUTE);
      const k = course(CourseStatut.IN_DELIVERY, livree, echouee, annulee, enRoute);
      const r = sansTelephoneClientTermine(k);
      expect(numeros(r)).toEqual([
        [null, null],
        [null, null],
        [null, null],
        [enRoute.order.phone, enRoute.order.customer?.phone],
      ]);
      // L'arrêt en cours est rendu tel quel
      expect(r.deliveries[3]).toBe(enRoute);
    });

    it('ne modifie jamais la course reçue : le siège et le restaurant gardent le numéro', () => {
      const k = course(CourseStatut.COMPLETED, livraison(DeliveryStatut.DELIVERED));
      const avant = JSON.parse(JSON.stringify(k)) as unknown;
      sansTelephoneClientTermine(k);
      expect(JSON.parse(JSON.stringify(k))).toEqual(avant);
    });

    it('trouve la course où qu\'elle soit : événement, offre, historique paginé', () => {
      const close = () => course(CourseStatut.COMPLETED, livraison(DeliveryStatut.DELIVERED));
      const evenement = sansTelephoneClientTermine({ course: close(), previous_statut: 'IN_DELIVERY', success_count: 1 });
      const offre = sansTelephoneClientTermine({ offer_id: 'f1', course: close(), expires_at: '2026-10-24T10:00:00.000Z' });
      const historique = sansTelephoneClientTermine({ items: [close(), close()], total: 2, page: 1 });
      expect(numeros(evenement.course)).toEqual([[null, null]]);
      expect(evenement.success_count).toBe(1);
      expect(numeros(offre.course)).toEqual([[null, null]]);
      expect(historique.items.map(numeros)).toEqual([[[null, null]], [[null, null]]]);
      expect(historique.total).toBe(2);
    });

    it('client sans compte : le numéro de la commande part quand même', () => {
      const l = livraison(DeliveryStatut.DELIVERED);
      l.order.customer = null;
      const r = sansTelephoneClientTermine(course(CourseStatut.IN_DELIVERY, l));
      expect(r.deliveries[0].order.phone).toBeNull();
      expect(r.deliveries[0].order.customer).toBeNull();
    });

    it('laisse passer ce qui n\'est pas une course', () => {
      expect(sansTelephoneClientTermine(null)).toBeNull();
      expect(sansTelephoneClientTermine('ok')).toBe('ok');
      const livraisonSeule = { id: 'l1', statut: DeliveryStatut.DELIVERED, course_id: 'k1' };
      expect(sansTelephoneClientTermine(livraisonSeule)).toBe(livraisonSeule);
    });
  });

  describe('contrôleur des courses du livreur', () => {
    it('toutes ses routes passent par l\'intercepteur', () => {
      const intercepteurs = Reflect.getMetadata(INTERCEPTORS_METADATA, CourseDelivererController) as unknown[];
      expect(intercepteurs).toContain(TelephoneClientLivreurInterceptor);
    });

    it('l\'intercepteur retire le numéro de la réponse', async () => {
      const i = new TelephoneClientLivreurInterceptor();
      const suite: CallHandler = { handle: () => of(course(CourseStatut.CANCELLED, livraison(DeliveryStatut.IN_ROUTE))) };
      const r = (await lastValueFrom(i.intercept({} as ExecutionContext, suite))) as Course;
      expect(numeros(r)).toEqual([[null, null]]);
    });
  });
});
