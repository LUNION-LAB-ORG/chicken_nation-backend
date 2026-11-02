import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  CrmCallOutcome,
  CrmEventType,
  CrmStatus,
  EntityStatus,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { OUTCOMES_DEFINITIFS, OUTCOMES_JOINTS, raisonRetenue, statutApresAppel } from '../crm.rules';
import { RecordCallDto } from '../dto/contact.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';

/** Options des anciennes routes de l'appli caisse (acquisition Glovo/Yango). */
export interface OptionsAppelAcquisition {
  /** Un « refus » de l'acquisition n'a pas de raison codifiée. */
  sansRaison?: boolean;
  /** L'appel existe aussi dans l'ancienne table : il ne sera jamais réimporté. */
  prospectCallId?: string;
  date?: Date;
}

/**
 * Saisie d'un appel (cahier §4.3) : statut, raison de non-commande,
 * commentaire, et rappel éventuel. L'appel est journalisé tel qu'il a eu lieu,
 * le contact en déduit son nouveau statut.
 */
@Injectable()
export class CrmCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
  ) {}

  async enregistrer(user: User, contactId: string, dto: RecordCallDto, options: OptionsAppelAcquisition = {}) {
    const contact = await this.prisma.crmContact.findFirst({
      where: { id: contactId, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        status: true,
        segment: true,
        segment_since: true,
        cycle: true,
        call_count: true,
        first_reached_at: true,
        qualified_at: true,
        assigned_to_id: true,
        campaign_id: true,
        campaign: { select: { status: true } },
      },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    await this.access.assertPeutTraiter(user, contact);
    if (contact.status === CrmStatus.CONVERTI) {
      throw new BadRequestException('Ce client a déjà commandé : il est sorti de la liste');
    }

    const statutAppel = await this.prisma.crmCallStatus.findFirst({
      where: { id: dto.call_status_id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
    });
    if (!statutAppel) throw new BadRequestException("Statut d'appel inconnu ou désactivé");

    const outcome = statutAppel.outcome;
    const raisonId = raisonRetenue(outcome, dto.loss_reason_id);
    if (outcome === CrmCallOutcome.NON_INTERESSE && !raisonId && !options.sansRaison) {
      throw new BadRequestException('Indiquez la raison pour laquelle le client ne commande pas');
    }
    if (raisonId) {
      // Même exigence que pour le statut : une raison retirée des réglages ne
      // s'enregistre plus, même depuis un écran resté ouvert.
      const raison = await this.prisma.crmReason.findFirst({
        where: { id: raisonId, is_active: true, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true },
      });
      if (!raison) throw new BadRequestException('Raison de non-commande inconnue ou désactivée');
    }

    const maintenant = options.date ?? new Date();
    const rappel = outcome === CrmCallOutcome.A_RAPPELER && dto.callback_at ? new Date(dto.callback_at) : null;
    if (rappel && rappel <= maintenant) {
      throw new BadRequestException('La date de rappel doit être dans le futur');
    }

    const { max_attempts } = await this.config.lireReglages();
    const joint = OUTCOMES_JOINTS.includes(outcome);
    const tentatives = contact.call_count + 1;
    const nouveauStatut = statutApresAppel(contact.status, outcome, {
      dejaJoint: !!contact.first_reached_at,
      tentatives,
      maxTentatives: max_attempts,
      ...(outcome === CrmCallOutcome.NON_JOINT && { sansReponse: await this.sansReponse(contact.id, contact.cycle) }),
    });
    // Un appel sur un client de l'annuaire vaut prise en charge : sa date
    // d'entrée devient celle de l'appel, pour que seule une commande passée
    // après compte comme une vente (problème 1 du 02/11).
    const priseEnCharge = contact.status === CrmStatus.NON_DEMARCHE;
    // L'appel compte pour la campagne en cours, même suspendue (il a eu lieu).
    const campagneId =
      contact.campaign_id && contact.campaign?.status !== CampaignStatus.COMPLETED
        ? contact.campaign_id
        : null;
    const commentaire = dto.comment?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      // Un contact de la file commune devient celui de l'agent qui l'appelle
      // (la direction, elle, le laisse dans la file : voir `prendre`).
      await this.access.prendre(tx, user, contact.id, maintenant);
      // Claim : si le client vient de commander pendant l'appel, ou si un
      // collègue l'a pris entre-temps, on n'écrit rien.
      const claim = await tx.crmContact.updateMany({
        where: { id: contact.id, status: { not: CrmStatus.CONVERTI }, ...this.access.conditionAgent(user) },
        data: {
          status: nouveauStatut,
          call_count: { increment: 1 },
          last_call_at: maintenant,
          last_call_status_id: statutAppel.id,
          last_call_outcome: outcome,
          callback_at: outcome === CrmCallOutcome.A_RAPPELER ? rappel : null,
          ...(joint && !contact.first_reached_at && { first_reached_at: maintenant }),
          ...(OUTCOMES_DEFINITIFS.includes(outcome) && !contact.qualified_at && { qualified_at: maintenant }),
          // Un client redevenu intéressé n'a plus de raison de ne pas commander :
          // l'ancienne fausserait l'analyse des blocages.
          ...(raisonId
            ? { loss_reason_id: raisonId }
            : outcome === CrmCallOutcome.INTERESSE && { loss_reason_id: null }),
          ...(commentaire && { last_comment: commentaire }),
          ...(priseEnCharge && { segment_since: maintenant }),
        },
      });
      if (claim.count === 0) {
        const actuel = await tx.crmContact.findUnique({
          where: { id: contact.id },
          select: { status: true, assigned_to_id: true },
        });
        if (actuel?.status === CrmStatus.CONVERTI) {
          throw new BadRequestException('Ce client vient de commander : il est sorti de la liste');
        }
        throw new ConflictException(
          actuel?.assigned_to_id ? await this.access.messagePris(actuel.assigned_to_id) : 'Ce contact vient de changer, rechargez la fiche',
        );
      }
      const appel = await tx.crmCall.create({
        data: {
          contact_id: contact.id,
          segment: contact.segment,
          // Un cycle ne change qu'à partir d'une fiche convertie, refusée plus haut.
          cycle: contact.cycle,
          agent_id: user.id,
          campaign_id: campagneId,
          call_status_id: statutAppel.id,
          status_label: statutAppel.label,
          outcome,
          reached: joint,
          attempt: tentatives,
          loss_reason_id: raisonId ?? null,
          comment: commentaire,
          callback_at: rappel,
          prospect_call_id: options.prospectCallId ?? null,
          created_at: maintenant,
        },
      });
      await this.events.journaliser(
        [
          {
            contact_id: contact.id,
            type: CrmEventType.APPEL,
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
      this.events.signaler([contact.id], 'appel');
      return resultat;
    });
  }

  /**
   * Appels « pas de réponse » d'affilée de ce passage, celui qu'on enregistre
   * compris : on compte depuis le dernier appel où le client a décroché. Un
   * client joint une fois repart donc de zéro, il n'est pas exempté à vie.
   */
  private async sansReponse(contactId: string, cycle: number): Promise<number> {
    const dernierJoint = await this.prisma.crmCall.findFirst({
      where: { contact_id: contactId, cycle, reached: true },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    const avant = await this.prisma.crmCall.count({
      where: {
        contact_id: contactId,
        cycle,
        outcome: CrmCallOutcome.NON_JOINT,
        ...(dernierJoint && { created_at: { gt: dernierJoint.created_at } }),
      },
    });
    return avant + 1;
  }
}
