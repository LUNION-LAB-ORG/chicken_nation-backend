import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { RewardCampaignService } from '../services/reward-campaign.service';
import { CreateRewardCampaignDto } from '../dto/create-reward-campaign.dto';

/**
 * Campagnes « Envoyer un cadeau » — back office (staff).
 * Réservé au module Fidélité. Le customer_id des destinataires est résolu côté
 * serveur (ids fournis ou tous les clients) ; jamais de portée client ici.
 */
@ApiTags('Reward Campaigns')
@Controller('fidelity/reward-campaigns')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class RewardCampaignController {
  constructor(private readonly rewardCampaignService: RewardCampaignService) {}

  @Post()
  @RequirePermission(Modules.FIDELITE, Action.CREATE)
  @ApiOperation({ summary: 'Créer/envoyer une campagne de cadeau (immédiat ou programmé)' })
  create(@Req() req: Request, @Body() dto: CreateRewardCampaignDto) {
    const adminId = (req.user as User).id;
    return this.rewardCampaignService.createCampaign(dto, adminId);
  }

  @Get()
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Lister les campagnes + suivi (ciblés / grattés)' })
  list() {
    return this.rewardCampaignService.listCampaigns();
  }

  @Get(':id')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: "Détail d'une campagne + suivi" })
  detail(@Param('id') id: string) {
    return this.rewardCampaignService.getCampaign(id);
  }

  @Get(':id/recipients')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({
    summary: 'Destinataires d\'une campagne + statut individuel (gratté / utilisé)',
  })
  recipients(@Param('id') id: string) {
    return this.rewardCampaignService.getCampaignRecipients(id);
  }

  @Patch(':id/cancel')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Annuler une campagne encore programmée' })
  cancel(@Param('id') id: string) {
    return this.rewardCampaignService.cancelCampaign(id);
  }
}
