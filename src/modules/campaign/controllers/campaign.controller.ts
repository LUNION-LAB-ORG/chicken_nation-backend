import { Controller, Get, Post, Body, Param, UseGuards, SetMetadata } from '@nestjs/common';
import { CampaignService } from '../services/campaign.service';
import { CreateCampaignDto } from '../dto/create-campaign.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { Modules } from 'src/modules/auth/enums/module-enum';

@Controller('campaigns')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post()
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'CREATE' })
  create(@Body() createCampaignDto: CreateCampaignDto) {
    return this.campaignService.create(createCampaignDto);
  }

  @Get()
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'READ' })
  findAll() {
    return this.campaignService.findAll();
  }

  @Get(':id')
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'READ' })
  findOne(@Param('id') id: string) {
    return this.campaignService.findOne(id);
  }

  @Post(':id/assign-prospects')
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'UPDATE' })
  assignProspects(@Param('id') id: string) {
    return this.campaignService.assignProspects(id);
  }
}
