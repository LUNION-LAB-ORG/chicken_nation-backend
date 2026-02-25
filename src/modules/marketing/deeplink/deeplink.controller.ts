import { Controller, Get, Post, Body, Query, Req, UseGuards } from '@nestjs/common';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { RecordClickDto } from './dto/recordClick.dto';
import { DeeplinkService } from './deeplink.service';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@ApiTags('Marketing')
@Controller('marketing/deeplink')
export class DeeplinkController {

  constructor(
    private readonly deeplinkService: DeeplinkService,
  ) { }

  @Post('click')
  @ApiOperation({ summary: 'Enregistre un nouveau clic sur le deeplink' })
  async recordClick(@Body() body: RecordClickDto, @Req() req: Request) {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.headers['x-real-ip']?.toString() ||
      req.socket.remoteAddress ||
      'unknown';
    const referer = req.headers.referer || 'unknown';

    return this.deeplinkService.recordClick({
      platform: body.platform,
      userAgent: body.userAgent,
      ip,
      referer,
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MARKETING, Action.READ)
  @ApiOperation({ summary: 'Récupère la liste paginée et filtrée des clics' })
  async getFilteredClicks(@Query() query: RecordClickQueryDto) {
    return this.deeplinkService.getFilteredClicks(query);
  }

  @Get('count')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MARKETING, Action.READ)
  @ApiOperation({ summary: 'Récupère le nombre total de clics correspondant aux filtres' })
  async getCount(@Query() query: RecordClickQueryDto) {
    const count = await this.deeplinkService.getClicksCount(query);
    return { totalClicks: count };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MARKETING, Action.EXPORT)
  @ApiOperation({ summary: 'Récupère les statistiques des clics' })
  async getClicksStats() {
    const count = await this.deeplinkService.getClicksStats();
    return count;
  }
}