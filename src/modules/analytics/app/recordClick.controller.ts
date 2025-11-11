import { Controller, Get, Post, Body, Query, Req } from '@nestjs/common';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { RecordClickDto } from './dto/recordClick.dto';
import { RecordClickService } from './recordClick.service';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Analytics')
@Controller('analytics/app')
export class RecordClickController {
  constructor(private readonly recordClickService: RecordClickService) { }

  @ApiOperation({ summary: 'Enregistre un nouveau clic sur l\'application' })
  @Post('app-click')
  async recordClick(@Body() body: RecordClickDto, @Req() req: Request) {

    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.headers['x-real-ip']?.toString() ||
      req.socket.remoteAddress ||
      'unknown';
    const referer = req.headers.referer || 'unknown';

    return this.recordClickService.recordClick({
      platform: body.platform,
      userAgent: body.userAgent,
      ip,
      referer,
    });
  }

  @ApiOperation({ summary: 'Récupère la liste paginée et filtrée des clics' })
  @Get()
  async getFilteredClicks(@Query() query: RecordClickQueryDto) {
    return this.recordClickService.getFilteredClicks(query);
  }

  @ApiOperation({ summary: 'Récupère le nombre total de clics correspondant aux filtres' })
  @Get('count')
  async getCount(@Query() query: RecordClickQueryDto) {
    const count = await this.recordClickService.getClicksCount(query);
    return { totalClicks: count };
  }

  @ApiOperation({ summary: 'Récupère les statistiques des clics' })
  @Get('stats')
  async getClicksStats() {
    const count = await this.recordClickService.getClicksStats();
    return count;
  }
}