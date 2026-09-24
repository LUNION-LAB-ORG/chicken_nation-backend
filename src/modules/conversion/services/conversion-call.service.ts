import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  ConversionCallOutcome,
  ConversionEventType,
  ConversionProspectStatus,
  EntityStatus,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { OUTCOMES_DEFINITIFS, OUTCOMES_JOINTS, statutApresAppel } from '../conversion.rules';
import { RecordCallDto } from '../dto/prospect.dto';
import { ConversionAccessService } from './conversion-access.service';
import { ConversionConfigService } from './conversion-config.service';
import { ConversionEventsService } from './conversion-events.service';

/**
 * Saisie d'un appel (cahier §4.3) : statut, raison de non-commande,
 * commentaire, et rappel éventuel. L'appel est journalisé tel qu'il a eu lieu,
 * le prospect en déduit son nouveau statut.
 */
@Injectable()
export class ConversionCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
    private readonly config: ConversionConfigService,
    private readonly events: ConversionEventsService,
  ) {}

  async enregistrer(user: User, prospectId: string, dto: RecordCallDto) {
    const prospect = await this.prisma.conversionProspect.findFirst({
      where: { id: prospectId, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        status: true,
        call_count: true,
        first_reached_at: true,
        qualified_at: true,
        assigned_to_id: true,
        campaign_id: true,
        campaign: { select: { status: true } },
      },
    });
    if (!prospect) throw new NotFoundException('Prospect introuvable');
    await this.access.assertPeutTraiter(user, prospect);
    if (prospect.status === ConversionProspectStatus.CONVERTI) {
      throw new BadRequestException('Ce client a déjà passé sa première commande');
    }

    const statutAppel = await this.prisma.conversionCallStatus.findFirst({
      where: { id: dto.call_status_id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
    });
    if (!statutAppel) throw new BadRequestException("Statut d'appel inconnu ou désactivé");

    const outcome = statutAppel.outcome;
    if (outcome === ConversionCallOutcome.NON_INTERESSE && !dto.loss_reason_id) {
      throw new BadRequestException('Indiquez la raison pour laquelle le client ne commande pas');
    }
    if (dto.loss_reason_id) {
      const raison = await this.prisma.prospectLossReason.findFirst({
        where: { id: dto.loss_reason_id, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true },
      });
      if (!raison) throw new BadRequestException('Raison de non-commande inconnue');
    }

    const maintenant = new Date();
    const rappel = outcome === ConversionCallOutcome.A_RAPPELER && dto.callback_at ? new Date(dto.callback_at) : null;
    if (rappel && rappel <= maintenant) {
      throw new BadRequestException('La date de rappel doit être dans le futur');
    }

    const { max_attempts } = await this.config.lireReglages();
    const joint = OUTCOMES_JOINTS.includes(outcome);
    const tentatives = prospect.call_count + 1;
    const nouveauStatut = statutApresAppel(prospect.status, outcome, {
      dejaJoint: !!prospect.first_reached_at,
      tentatives,
      maxTentatives: max_attempts,
    });
    // L'appel compte pour la campagne en cours, même suspendue (il a eu lieu).
    const campagneId =
      prospect.campaign_id && prospect.campaign?.status !== CampaignStatus.COMPLETED
        ? prospect.campaign_id
        : null;
    const commentaire = dto.comment?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      // Claim : si le client vient de commander pendant l'appel, on ne
      // réécrit pas sa conversion.
      const claim = await tx.conversionProspect.updateMany({
        where: { id: prospect.id, status: { not: ConversionProspectStatus.CONVERTI } },
        data: {
          status: nouveauStatut,
          call_count: { increment: 1 },
          last_call_at: maintenant,
          last_call_status_id: statutAppel.id,
          last_call_outcome: outcome,
          callback_at: outcome === ConversionCallOutcome.A_RAPPELER ? rappel : null,
          ...(joint && !prospect.first_reached_at && { first_reached_at: maintenant }),
          ...(OUTCOMES_DEFINITIFS.includes(outcome) && !prospect.qualified_at && { qualified_at: maintenant }),
          // Un client redevenu intéressé n'a plus de raison de ne pas commander :
          // l'ancienne fausserait l'analyse des blocages.
          ...(dto.loss_reason_id
            ? { loss_reason_id: dto.loss_reason_id }
            : outcome === ConversionCallOutcome.INTERESSE && { loss_reason_id: null }),
          ...(commentaire && { last_comment: commentaire }),
        },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Ce client vient de passer sa première commande');
      }
      const appel = await tx.conversionCall.create({
        data: {
          prospect_id: prospect.id,
          agent_id: user.id,
          campaign_id: campagneId,
          call_status_id: statutAppel.id,
          status_label: statutAppel.label,
          outcome,
          reached: joint,
          attempt: tentatives,
          loss_reason_id: dto.loss_reason_id ?? null,
          comment: commentaire,
          callback_at: rappel,
        },
      });
      await this.events.journaliser(
        [
          {
            prospect_id: prospect.id,
            type: ConversionEventType.APPEL,
            label: `Appel n° ${tentatives} : ${statutAppel.label}`,
            actor_id: user.id,
            campaign_id: campagneId,
            data: { call_id: appel.id, outcome, statut: nouveauStatut },
          },
        ],
        tx,
      );
      return { appel, statut: nouveauStatut };
    }).then((resultat) => {
      this.events.signaler([prospect.id], 'appel');
      return resultat;
    });
  }
}
