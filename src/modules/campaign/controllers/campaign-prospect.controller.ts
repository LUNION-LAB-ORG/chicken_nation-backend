import { Controller, Get, Post, Body, Param, UseGuards, Patch, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { CampaignService } from '../services/campaign.service';
import { UpdateCallStatusDto } from '../dto/update-call-status.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

@ApiTags('Campagnes de conversion')
@Controller('campaigns/prospects')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CampaignProspectController {
  constructor(private readonly campaignService: CampaignService) {}

  @Get('my-queue')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  getMyQueue(@Req() req: Request, @Query('status') status?: string) {
    return this.campaignService.getAgentQueue((req.user as User).id, status);
  }

  @Patch(':id/call-status')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  updateCallStatus(
    @Req() req: Request,
    @Param('id') prospectId: string,
    @Body() dto: UpdateCallStatusDto,
  ) {
    return this.campaignService.updateCallStatus(req.user as User, prospectId, dto);
  }

  @Post(':id/trigger-whatsapp')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  triggerWhatsapp(@Req() req: Request, @Param('id') prospectId: string) {
    return this.campaignService.triggerWhatsapp(req.user as User, prospectId);
  }
}
