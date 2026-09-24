import { Controller, Get, Post, Body, Param, UseGuards, Patch, SetMetadata, Query } from '@nestjs/common';
import { CampaignService } from '../services/campaign.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Req } from '@nestjs/common';

@Controller('campaigns/prospects')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CampaignProspectController {
  constructor(private readonly campaignService: CampaignService) {}

  @Get('my-queue')
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'READ' })
  getMyQueue(@Req() req: any, @Query('status') status?: string) {
    return this.campaignService.getAgentQueue(req.user.id, status);
  }

  @Patch(':id/call-status')
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'UPDATE' })
  updateCallStatus(
    @Param('id') prospectId: string,
    @Body() updateData: {
      status: string;
      loss_reason_id?: string;
      comment?: string;
    },
    @Req() req: any
  ) {
    return this.campaignService.updateCallStatus(prospectId, req.user.id, updateData);
  }

  @Post(':id/trigger-whatsapp')
  @SetMetadata('permission', { module: Modules.BASE_DONNEES, action: 'UPDATE' })
  triggerWhatsapp(@Param('id') prospectId: string, @Req() req: any) {
    return this.campaignService.triggerWhatsapp(prospectId, req.user.id);
  }
}
