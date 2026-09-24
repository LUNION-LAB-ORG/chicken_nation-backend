import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CampaignService } from '../services/campaign.service';
import { CreateConversionCampaignDto } from '../dto/create-campaign.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

/**
 * Permissions via `RequirePermission` et l'enum `Action` : les rôles stockent
 * les actions en minuscules (`update`), un `'UPDATE'` écrit à la main ne
 * correspondait à aucun rôle et renvoyait 403 à tout le monde, admin compris.
 */
@ApiTags('Campagnes de conversion')
@Controller('campaigns')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post()
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  create(@Body() createCampaignDto: CreateConversionCampaignDto) {
    return this.campaignService.create(createCampaignDto);
  }

  @Get()
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  findAll() {
    return this.campaignService.findAll();
  }

  @Get(':id')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  findOne(@Param('id') id: string) {
    return this.campaignService.findOne(id);
  }

  @Post(':id/assign-prospects')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  assignProspects(@Param('id') id: string) {
    return this.campaignService.assignProspects(id);
  }
}
