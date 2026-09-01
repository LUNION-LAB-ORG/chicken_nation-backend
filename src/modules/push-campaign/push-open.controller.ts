import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { PushCampaignService } from './push-campaign.service';
import { RecordOpenDto } from './dto/record-open.dto';

/**
 * Remontée d'une ouverture de notification par le téléphone du client.
 *
 * ⚠️ Contrôleur SEPARE de celui des campagnes, à dessein : celui ci est
 * réservé au personnel et porte une garde de permission, alors que cette route
 * doit être appelée par un CLIENT avec son propre jeton. Les mélanger aurait
 * imposé un compromis sur l'une ou l'autre des deux gardes.
 *
 * ⚠️ La mesure ne peut venir que d'ici. Le geste se produit sur le téléphone et
 * n'en sort jamais tout seul : aucune donnée serveur ne permet de reconstituer
 * un taux de clic, et prétendre le contraire reviendrait à inventer un chiffre.
 */
@ApiTags('Push Campaigns')
@Controller('push-opens')
export class PushOpenController {
  constructor(private readonly service: PushCampaignService) {}

  @Post()
  @UseGuards(JwtCustomerAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signaler l'ouverture d'une notification" })
  async record(@Body() dto: RecordOpenDto, @Req() req: Request) {
    return this.service.enregistrerOuverture(
      dto.campaign_id,
      (req.user as Customer)?.id ?? null,
      dto.platform ?? null,
    );
  }
}
