import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { CreateCampaignDto } from '../dto/create-campaign.dto';
import { CampaignStatus } from '@prisma/client';

@Injectable()
export class CampaignService {
  constructor(
    private prisma: PrismaService,
    private twilioService: TwilioService
  ) {}

  async create(createCampaignDto: CreateCampaignDto) {
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

  async assignProspects(id: string) {
    const campaign = await this.findOne(id);
    if (!campaign) throw new NotFoundException('Campaign not found');

    const agents = campaign.assigned_agents.map(ca => ca.agent_id);
    if (agents.length === 0) throw new Error('No agents assigned to this campaign');

    // Find unassigned prospects that have never ordered
    // Specifically looking for prospects that are not assigned to a campaign and have status NOUVEAU or INSCRIT
    // We only take prospects who haven't ordered yet, which implies first_order_id is null
    const eligibleProspects = await this.prisma.prospect.findMany({
      where: {
        campaign_id: null,
        first_order_id: null,
      },
      select: { id: true }
    });

    if (eligibleProspects.length === 0) return { count: 0, message: 'No eligible prospects found' };

    let assignedCount = 0;
    // Round-robin assignment
    for (let i = 0; i < eligibleProspects.length; i++) {
      const prospect = eligibleProspects[i];
      const agentId = agents[i % agents.length];

      await this.prisma.prospect.update({
        where: { id: prospect.id },
        data: {
          campaign_id: campaign.id,
          assigned_to_id: agentId,
          status: 'A_APPELER'
        }
      });
      assignedCount++;
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
    const where: any = { assigned_to_id: agentId };
    
    // Only return non-converted prospects
    where.status = { not: 'CONVERTI' };

    if (status) {
      where.status = status;
    }

    return this.prisma.prospect.findMany({
      where,
      include: {
        campaign: { select: { id: true, name: true } },
        calls: { orderBy: { created_at: 'desc' }, take: 1 }, // get latest call
      },
      orderBy: { created_at: 'asc' }
    });
  }

  async updateCallStatus(prospectId: string, agentId: string, updateData: { status: string; loss_reason_id?: string; comment?: string; }) {
    const prospect = await this.prisma.prospect.findUnique({
      where: { id: prospectId }
    });

    if (!prospect) throw new NotFoundException('Prospect not found');

    // 1. Create the call log
    await this.prisma.prospectCall.create({
      data: {
        prospect_id: prospectId,
        agent_id: agentId,
        result: updateData.status as any, // ProspectCallResult enum mapping might be needed
        note: updateData.comment || '', 
      }
    });

    // 2. Update the prospect
    return this.prisma.prospect.update({
      where: { id: prospectId },
      data: {
        status: updateData.status as any,
        loss_reason_id: updateData.loss_reason_id,
        called_at: new Date(),
        ...(updateData.status === 'JOINT' && !prospect.joined_at ? { joined_at: new Date() } : {})
      }
    });
  }

  async triggerWhatsapp(prospectId: string, agentId: string) {
    const prospect = await this.prisma.prospect.findUnique({
      where: { id: prospectId },
      include: { promo_code: true }
    });

    if (!prospect) throw new NotFoundException('Prospect not found');
    
    let promoCodeId = prospect.promo_code_id;
    let codeStr = prospect.promo_code?.code;

    if (!promoCodeId) {
      codeStr = `CN-${prospect.name.substring(0, 3).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    }

    if (prospect.phone) {
      const smsBody = `Bonjour ${prospect.name.split(' ')[0]} ! Voici votre code cadeau: ${codeStr || 'BIENVENUE10'} pour commander sur l'application Chicken Nation. Lien: https://chickennation.app/dl`;
      
      try {
        await this.twilioService.sendCouponMessage({
          phoneNumber: prospect.phone,
          name: prospect.name.split(' ')[0],
          code: codeStr || 'BIENVENUE10',
          validityDays: 30,
          smsBody
        });
      } catch (e) {
        console.error('Failed to send WhatsApp:', e);
      }
    }
    
    return this.prisma.prospect.update({
      where: { id: prospectId },
      data: {
        status: 'COUPON_ENVOYE',
        coupon_sent_at: new Date()
      }
    });
  }
}
