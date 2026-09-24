import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  EntityStatus,
  ProspectPlatform,
  ProspectStatus,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ProspectService } from 'src/modules/prospect/services/prospect.service';
import { CreateConversionCampaignDto } from '../dto/create-campaign.dto';
import { UpdateCallStatusDto } from '../dto/update-call-status.dto';

@Injectable()
export class CampaignService {
  constructor(
    private prisma: PrismaService,
    private prospectService: ProspectService,
  ) {}

  async create(createCampaignDto: CreateConversionCampaignDto) {
    const { agent_ids, ...campaignData } = createCampaignDto;

    return this.prisma.conversionCampaign.create({
      data: {
        ...campaignData,
        assigned_agents: {
          create: agent_ids.map(agent_id => ({ agent_id }))
        }
      },
      include: {
        lead_agent: { select: { id: true, fullname: true, email: true } },
        assigned_agents: {
          include: { agent: { select: { id: true, fullname: true, email: true } } }
        }
      }
    });
  }

  async findAll() {
    return this.prisma.conversionCampaign.findMany({
      include: {
        lead_agent: { select: { id: true, fullname: true, email: true } },
        assigned_agents: {
          include: { agent: { select: { id: true, fullname: true, email: true } } }
        },
        _count: {
          select: { prospects: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });
  }

  async findOne(id: string) {
    const campaign = await this.prisma.conversionCampaign.findUnique({
      where: { id },
      include: {
        lead_agent: { select: { id: true, fullname: true, email: true } },
        assigned_agents: {
          include: { agent: { select: { id: true, fullname: true, email: true } } }
        },
        _count: {
          select: { prospects: true }
        }
      }
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign #${id} not found`);
    }
    return campaign;
  }

  /**
   * Répartit les prospects éligibles entre les agents de la campagne.
   *
   * Seuls les inscrits de l'app (`APP_ORGANIC`) sont concernés. Les contacts
   * Glovo/Yango ont leur propre file d'appels, et la première version les
   * prenait tous (plus de 20 000) en écrasant leur statut par `A_APPELER` :
   * un seul clic aurait effacé tout l'entonnoir de l'opération. Le statut
   * n'est d'ailleurs plus touché ici, rattacher un prospect n'est pas l'appeler.
   */
  async assignProspects(id: string) {
    const campaign = await this.findOne(id);

    const agents = campaign.assigned_agents.map(ca => ca.agent_id);
    if (agents.length === 0) {
      throw new BadRequestException("Aucun agent n'est rattaché à cette campagne");
    }

    const eligibleProspects = await this.prisma.prospect.findMany({
      where: {
        platform: ProspectPlatform.APP_ORGANIC,
        campaign_id: null,
        status: { not: ProspectStatus.CONVERTI },
        entity_status: { not: EntityStatus.DELETED },
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
    });

    if (eligibleProspects.length === 0) return { count: 0, message: 'No eligible prospects found' };

    // Répartition circulaire, puis un seul update par agent au lieu d'un par
    // prospect. `campaign_id: null` dans le where : un prospect rattaché entre
    // temps à une autre campagne n'est pas repris (une campagne active à la fois).
    const idsByAgent = new Map<string, string[]>(agents.map(agentId => [agentId, []]));
    eligibleProspects.forEach((prospect, i) => {
      idsByAgent.get(agents[i % agents.length])!.push(prospect.id);
    });

    let assignedCount = 0;
    for (const [agentId, ids] of idsByAgent) {
      if (ids.length === 0) continue;
      const res = await this.prisma.prospect.updateMany({
        where: { id: { in: ids }, campaign_id: null },
        data: { campaign_id: campaign.id, assigned_to_id: agentId },
      });
      assignedCount += res.count;
    }

    // Update campaign status if it was PLANIFIED
    if (campaign.status === CampaignStatus.PLANIFIED && assignedCount > 0) {
      await this.prisma.conversionCampaign.update({
        where: { id: campaign.id },
        data: { status: CampaignStatus.ACTIVE }
      });
    }

    return { count: assignedCount, message: `Successfully assigned ${assignedCount} prospects` };
  }

  async getAgentQueue(agentId: string, status?: string) {
    if (status && !(Object.values(ProspectStatus) as string[]).includes(status)) {
      throw new BadRequestException(`Statut inconnu : ${status}`);
    }

    return this.prisma.prospect.findMany({
      where: {
        assigned_to_id: agentId,
        entity_status: { not: EntityStatus.DELETED },
        // Only return non-converted prospects
        status: status ? (status as ProspectStatus) : { not: ProspectStatus.CONVERTI },
      },
      include: {
        campaign: { select: { id: true, name: true } },
        calls: { orderBy: { created_at: 'desc' }, take: 1 }, // get latest call
      },
      orderBy: { created_at: 'asc' },
      take: 200,
    });
  }

  /**
   * Même règle que la file Glovo/Yango : `markCall` calcule le rang de
   * l'appel, cloisonne par restaurant et ne rétrograde jamais un prospect
   * plus avancé. La raison de non-commande vient en plus.
   */
  async updateCallStatus(user: User, prospectId: string, dto: UpdateCallStatusDto) {
    if (dto.loss_reason_id) {
      const reason = await this.prisma.prospectLossReason.findUnique({
        where: { id: dto.loss_reason_id },
        select: { id: true },
      });
      if (!reason) throw new NotFoundException('Raison de non-commande introuvable');
    }

    const updated = await this.prospectService.markCall(user, prospectId, {
      result: dto.status,
      note: dto.comment,
    });
    if (!dto.loss_reason_id) return updated;

    return this.prisma.prospect.update({
      where: { id: prospectId },
      data: { loss_reason_id: dto.loss_reason_id },
      include: { restaurant: { select: { id: true, name: true } } },
    });
  }

  /**
   * Le coupon passe par `sendCoupon`, le seul chemin qui crée réellement le
   * code promo en base. La première version inventait un code sans jamais
   * l'enregistrer (le client recevait un code refusé à la caisse) et envoyait
   * un lien vers un domaine qui n'est pas celui de Chicken Nation.
   */
  async triggerWhatsapp(user: User, prospectId: string) {
    return this.prospectService.sendCoupon(user, prospectId);
  }
}
