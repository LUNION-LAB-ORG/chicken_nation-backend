import re

with open('src/modules/campaign/services/campaign.service.ts', 'r') as f:
    content = f.read()

# Add imports
content = content.replace(
    "import { PrismaService } from 'src/database/services/prisma.service';",
    "import { PrismaService } from 'src/database/services/prisma.service';\nimport { TwilioService } from 'src/twilio/services/twilio.service';"
)

# Add TwilioService to constructor
content = content.replace(
    "constructor(private prisma: PrismaService) {}",
    "constructor(\n    private prisma: PrismaService,\n    private twilioService: TwilioService\n  ) {}"
)

# Fix assignProspects and add remaining methods
methods = """    return { count: assignedCount, message: `Successfully assigned ${assignedCount} prospects` };
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
}"""

# Replace the end of assignProspects and the closing bracket of the class
content = re.sub(
    r"    return \{ count: assignedCount, message: `Successfully assigned \$\{assignedCount\} prospects` \};\s+\}",
    methods,
    content
)

with open('src/modules/campaign/services/campaign.service.ts', 'w') as f:
    f.write(content)
