import { Controller, Get, Post, Body, Query, Req } from '@nestjs/common';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { RecordClickDto } from './dto/recordClick.dto';
import { AppMobileService } from './app-mobile.service';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

@ApiTags('Marketing')
@Controller('marketing/app-mobile')
export class AppMobileController {

  private readonly minVersion: string;
  private readonly playstore_link: string;
  private readonly apptore_link: string;
  private readonly forceUpdate: boolean;

  constructor(
    private readonly AppMobileService: AppMobileService,
    private configService: ConfigService
  ) {
    this.minVersion = this.configService.get<string>('VERSION_APP_MOBILE', "1.0.0");
    this.playstore_link = this.configService.get<string>('PLAY_STORE_LINK', "1.0.0");
    this.apptore_link = this.configService.get<string>('APP_STORE_LINK', "1.0.0");
    this.forceUpdate = this.configService.get<string>('FORCE_UPDATE_APP_MOBILE') === "true"
  }

  @ApiOperation({ summary: 'Enregistre un nouveau clic sur l\'application' })
  @Post('app-click')
  async recordClick(@Body() body: RecordClickDto, @Req() req: Request) {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.headers['x-real-ip']?.toString() ||
      req.socket.remoteAddress ||
      'unknown';
    const referer = req.headers.referer || 'unknown';

    return this.AppMobileService.recordClick({
      platform: body.platform,
      userAgent: body.userAgent,
      ip,
      referer,
    });
  }

  @ApiOperation({ summary: 'Récupère la liste paginée et filtrée des clics' })
  @Get()
  async getFilteredClicks(@Query() query: RecordClickQueryDto) {
    return this.AppMobileService.getFilteredClicks(query);
  }

  @ApiOperation({ summary: 'Récupère le nombre total de clics correspondant aux filtres' })
  @Get('count')
  async getCount(@Query() query: RecordClickQueryDto) {
    const count = await this.AppMobileService.getClicksCount(query);
    return { totalClicks: count };
  }

  @ApiOperation({ summary: 'Récupère les statistiques des clics' })
  @Get('stats')
  async getClicksStats() {
    const count = await this.AppMobileService.getClicksStats();
    return count;
  }

  @ApiOperation({ summary: 'Récupère la configuration de version pour l\'application mobile' })
  @Get('version')
  getMobileVersion() {
    return {
      minVersion: this.minVersion, // Change ceci quand tu veux forcer une mise à jour
      title: 'Mise à jour disponible',
      message: 'Une nouvelle version est disponible pour améliorer votre expérience.',
      // Remplace par l'ID de ton app Apple
      storeUrlIOS: this.apptore_link,
      // Remplace par ton package name Android
      storeUrlAndroid: this.playstore_link,
      forceUpdate: this.forceUpdate,
    };
  }
}