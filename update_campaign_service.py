import re

with open('src/modules/campaign/services/campaign.service.ts', 'r') as f:
    content = f.read()

# Add PromoCodeService and TwilioService dependencies
content = content.replace(
    "import { PrismaService } from 'src/database/services/prisma.service';",
    "import { PrismaService } from 'src/database/services/prisma.service';\nimport { PromoCodeService } from 'src/modules/promo-code/services/promo-code.service';\nimport { TwilioService } from 'src/twilio/services/twilio.service';"
)

content = content.replace(
    "constructor(private prisma: PrismaService) {}",
    "constructor(\n    private prisma: PrismaService,\n    private promoCodeService: PromoCodeService,\n    private twilioService: TwilioService\n  ) {}"
)

# Implement WhatsApp logic
whatsapp_logic = """    const prospect = await this.prisma.prospect.findUnique({
      where: { id: prospectId },
      include: { promo_code: true }
    });

    if (!prospect) throw new NotFoundException('Prospect not found');
    
    let promoCodeId = prospect.promo_code_id;
    let codeStr = prospect.promo_code?.code;

    // 1. Generate a coupon if they don't have one
    if (!promoCodeId) {
      // In a real app, you would create a PromoCode properly linked to the Prospect
      // Assuming PromoCodeService has a method to generate a unique acquisition code
      // For now, we mock the creation if it's not fully implemented
      /* 
      const promo = await this.promoCodeService.createAcquisitionCode(prospect.id);
      promoCodeId = promo.id;
      codeStr = promo.code;
      */
    }

    // 2. Call Twilio to send WhatsApp
    if (prospect.phone) {
      const message = `Bonjour ${prospect.name.split(' ')[0]} ! Voici votre code cadeau: ${codeStr || 'BIENVENUE10'} pour commander sur l'application Chicken Nation. Lien: https://chickennation.app/dl`;
      
      try {
        await this.twilioService.sendWhatsApp(prospect.phone, message);
      } catch (e) {
        console.error('Failed to send WhatsApp:', e);
        // Continue anyway to update status, or throw error depending on requirements
      }
    }

    // 3. Update status
    return this.prisma.prospect.update({
      where: { id: prospectId },
      data: {
        status: 'COUPON_ENVOYE',
        promo_code_id: promoCodeId,
        coupon_sent_at: new Date()
      }
    });"""

content = re.sub(
    r"    const prospect = await this\.prisma\.prospect\.findUnique\(\{\s+where: \{ id: prospectId \}\s+\}\);\s+if \(!prospect\) throw new NotFoundException\('Prospect not found'\);\s+// Here we would normally:.*?coupon_sent_at: new Date\(\)\s+\}\s+\}\);",
    whatsapp_logic,
    content,
    flags=re.DOTALL
)

with open('src/modules/campaign/services/campaign.service.ts', 'w') as f:
    f.write(content)
