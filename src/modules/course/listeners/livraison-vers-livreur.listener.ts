import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseChannels } from '../enums/course-channels';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import type { DeliveryStatutChangedPayload } from '../interfaces/course-event.interface';

/** Raison de `course:statut:changed` quand c'est une livraison de la course qui change. */
export const raisonLivraison = (statut: string) => `LIVRAISON_${statut}`;

/**
 * Une livraison du livreur change de statut (arrivée déduite de la position,
 * première livraison démarrée par le serveur au départ, livraison suivante) :
 * le LIVREUR reçoit `course:statut:changed` avec sa course à jour, comme pour
 * tout autre changement de sa course. Son appli relit la course dans la
 * seconde et vibre (« chez le client »…), sans rien à toucher.
 *
 * `course:delivery:statut:changed` reste réservé au backoffice. Émis vers la
 * seule salle du livreur, directement sur le socket : le planificateur, le
 * backoffice et la caisse ont déjà leur propre événement.
 */
@Injectable()
export class LivraisonVersLivreurListener {
  private readonly logger = new Logger(LivraisonVersLivreurListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appGateway: AppGateway,
  ) {}

  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async onLivraison(payload: DeliveryStatutChangedPayload): Promise<void> {
    if (!payload?.course_id) return;
    try {
      const course = await this.prisma.course.findUnique({
        where: { id: payload.course_id },
        include: COURSE_FULL_INCLUDE,
      });
      if (!course?.deliverer_id) return;
      this.appGateway.emitToDeliverer(course.deliverer_id, CourseChannels.COURSE_STATUT_CHANGED, {
        course,
        previous_statut: course.statut,
        new_statut: course.statut,
        reason: raisonLivraison(payload.new_statut),
        livraison: {
          id: payload.delivery?.id ?? null,
          order_id: payload.delivery?.order_id ?? null,
          previous_statut: payload.previous_statut,
          new_statut: payload.new_statut,
        },
      });
    } catch (err) {
      this.logger.warn(`Livraison ${payload.delivery?.id ?? '?'} : livreur non prévenu (${(err as Error)?.message ?? err})`);
    }
  }
}
