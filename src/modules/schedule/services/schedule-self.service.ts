import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PresenceCheckResponse,
  RestDay,
  RestDaySource,
  ShiftAssignment,
  ShiftAssignmentStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { ScheduleSettingsHelper } from '../helpers/schedule-settings.helper';

/**
 * Actions self-service du livreur sur son planning :
 *   - Accepter/refuser un shift assigné
 *   - Ajouter/retirer un jour de repos pour LUI-MÊME
 *   - Répondre au check-in matinal de présence
 *
 * Toutes les méthodes vérifient l'appartenance (le livreur ne peut agir que
 * sur ses propres assignments / rest days).
 */
@Injectable()
export class ScheduleSelfService {
  private readonly logger = new Logger(ScheduleSelfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ScheduleSettingsHelper,
  ) {}

  /**
   * Le livreur confirme sa présence sur un shift.
   * @throws ForbiddenException si l'assignment n'appartient pas au livreur
   * @throws BadRequestException si déjà CONFIRMED ou REFUSED
   */
  async acceptAssignment(delivererId: string, assignmentId: string): Promise<ShiftAssignment> {
    const assignment = await this.prisma.shiftAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new NotFoundException(`Assignment ${assignmentId} introuvable`);
    if (assignment.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cet assignment n'appartient pas au livreur connecté");
    }
    if (assignment.status !== ShiftAssignmentStatus.ASSIGNED) {
      throw new BadRequestException(
        `Assignment déjà ${assignment.status} (impossible de re-confirmer)`,
      );
    }

    return this.prisma.shiftAssignment.update({
      where: { id: assignmentId },
      data: {
        status: ShiftAssignmentStatus.CONFIRMED,
        confirmed_at: new Date(),
      },
    });
  }

  /**
   * Le livreur refuse un shift (avec raison optionnelle).
   * @throws ForbiddenException si l'assignment n'appartient pas au livreur
   * @throws BadRequestException si déjà CONFIRMED ou REFUSED
   */
  async refuseAssignment(
    delivererId: string,
    assignmentId: string,
    reason?: string,
  ): Promise<ShiftAssignment> {
    const assignment = await this.prisma.shiftAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new NotFoundException(`Assignment ${assignmentId} introuvable`);
    if (assignment.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cet assignment n'appartient pas au livreur connecté");
    }
    if (assignment.status !== ShiftAssignmentStatus.ASSIGNED) {
      throw new BadRequestException(
        `Assignment déjà ${assignment.status} (impossible de refuser)`,
      );
    }

    return this.prisma.shiftAssignment.update({
      where: { id: assignmentId },
      data: {
        status: ShiftAssignmentStatus.REFUSED,
        refused_at: new Date(),
        refusal_reason: reason ?? null,
      },
    });
  }

  /**
   * Le livreur ajoute un jour de repos pour LUI-MÊME (impacte que lui).
   * Si un RestDay AUTO existe déjà pour cette date, on le promote en MANUAL_DELIVERER.
   *
   * @throws BadRequestException si setting `allow_rest_day_override = false`
   *   ou si la date est dans le passé
   */
  async addRestDay(delivererId: string, date: Date, reason?: string): Promise<RestDay> {
    const settings = await this.settings.load();
    if (!settings.allowRestDayOverride) {
      throw new BadRequestException(
        "L'admin a désactivé la modification des repos par les livreurs",
      );
    }

    const today = startOfDay(new Date());
    const targetDay = startOfDay(date);
    if (targetDay < today) {
      throw new BadRequestException("Impossible d'ajouter un repos dans le passé");
    }

    // Upsert : remplace un AUTO existant (la source MANUAL_DELIVERER prime).
    const existing = await this.prisma.restDay.findUnique({
      where: { deliverer_id_date: { deliverer_id: delivererId, date: targetDay } },
    });
    if (existing) {
      return this.prisma.restDay.update({
        where: { id: existing.id },
        data: {
          source: RestDaySource.MANUAL_DELIVERER,
          reason: reason ?? existing.reason,
        },
      });
    }
    return this.prisma.restDay.create({
      data: {
        deliverer_id: delivererId,
        date: targetDay,
        source: RestDaySource.MANUAL_DELIVERER,
        reason,
      },
    });
  }

  /**
   * Le livreur retire un jour de repos pour LUI-MÊME.
   * Ne peut retirer que les RestDay qu'il a créés (MANUAL_DELIVERER).
   * Les MANUAL_ADMIN et AUTO ne sont pas suppressibles côté livreur.
   *
   * @throws ForbiddenException si le RestDay n'est pas MANUAL_DELIVERER
   */
  async removeRestDay(delivererId: string, restDayId: string): Promise<void> {
    const restDay = await this.prisma.restDay.findUnique({ where: { id: restDayId } });
    if (!restDay) throw new NotFoundException(`Repos ${restDayId} introuvable`);
    if (restDay.deliverer_id !== delivererId) {
      throw new ForbiddenException("Ce repos n'appartient pas au livreur connecté");
    }
    if (restDay.source !== RestDaySource.MANUAL_DELIVERER) {
      throw new ForbiddenException(
        `Tu ne peux pas supprimer un repos ${restDay.source} (admin ou auto)`,
      );
    }

    const today = startOfDay(new Date());
    if (startOfDay(restDay.date) < today) {
      throw new BadRequestException("Impossible de modifier un repos passé");
    }

    await this.prisma.restDay.delete({ where: { id: restDayId } });
  }

  /**
   * Réponse au check-in matinal "Tu es opérationnel aujourd'hui ?"
   * Crée ou met à jour le DailyPresenceCheck du jour.
   *
   * @throws BadRequestException si le livreur a déjà répondu pour aujourd'hui
   */
  async respondPresenceCheck(
    delivererId: string,
    response: PresenceCheckResponse,
  ): Promise<{ id: string; date: string; response: PresenceCheckResponse }> {
    const today = startOfDay(new Date());

    const existing = await this.prisma.dailyPresenceCheck.findUnique({
      where: { deliverer_id_date: { deliverer_id: delivererId, date: today } },
    });

    if (existing && existing.response !== PresenceCheckResponse.NO_RESPONSE) {
      throw new BadRequestException(
        `Tu as déjà répondu pour aujourd'hui (${existing.response})`,
      );
    }

    const upserted = await this.prisma.dailyPresenceCheck.upsert({
      where: { deliverer_id_date: { deliverer_id: delivererId, date: today } },
      update: { response, responded_at: new Date() },
      create: {
        deliverer_id: delivererId,
        date: today,
        response,
        responded_at: new Date(),
      },
    });

    this.logger.log(
      `Check-in ${response} pour livreur ${delivererId.slice(0, 8)} (${today.toISOString().substring(0, 10)})`,
    );

    return {
      id: upserted.id,
      date: upserted.date.toISOString().substring(0, 10),
      response: upserted.response,
    };
  }
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
