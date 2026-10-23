import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CourseStatut } from '@prisma/client';

import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CourseChannels } from '../enums/course-channels';
import { referencesAttendues, texteRetenue } from '../helpers/application-plan.rules';
import type { CourseStatutChangedPayload } from '../interfaces/course-event.interface';

/**
 * RETENUE ANNONCÉE À L'ARRIVÉE AU COMPTOIR (relecture du 23/10).
 *
 * Une retenue posée sur une course ACCEPTÉE (livreur encore en route) n'est
 * pas annoncée tout de suite : « Attends 4 min » reçu sur la route ferait
 * croire au livreur qu'il doit attendre avant de rouler, et les minutes
 * comptées depuis l'instant de la retenue ne disent pas son attente réelle
 * au comptoir. Elle lui est annoncée quand il arrive au restaurant (par
 * l'appli ou d'après sa position), minutes comptées de là, avec la vibration
 * et la notification « attente » habituelles (canal des offres).
 */
@Injectable()
export class RetenueALArriveeListener {
  private readonly logger = new Logger(RetenueALArriveeListener.name);

  constructor(private readonly push: DelivererPushService) {}

  @OnEvent(CourseChannels.COURSE_STATUT_CHANGED)
  onStatut(payload: CourseStatutChangedPayload, maintenant = new Date()): boolean {
    try {
      const course = payload?.course;
      if (!course?.deliverer_id) return false;
      if (payload.previous_statut !== CourseStatut.ACCEPTED || payload.new_statut !== CourseStatut.AT_RESTAURANT) return false;
      const jusqua = course.retenue_jusqua ? new Date(course.retenue_jusqua) : null;
      if (!jusqua || jusqua.getTime() <= maintenant.getTime()) return false;

      const texte = texteRetenue({ jusqua, maintenant });
      this.push.notifyCourseAttente({
        delivererId: course.deliverer_id,
        courseId: course.id,
        titre: texte.titre,
        corps: texte.corps,
        jusqua,
        attendues: referencesAttendues(course.commandes_attendues),
      });
      return true;
    } catch (err) {
      this.logger.warn(`Retenue non annoncée à l'arrivée : ${(err as Error)?.message ?? err}`);
      return false;
    }
  }
}
