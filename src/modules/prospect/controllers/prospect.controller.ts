import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ProspectService } from '../services/prospect.service';
import { ProspectScanService } from '../services/prospect-scan.service';
import { CreateProspectDto } from '../dto/create-prospect.dto';
import { MarkCallDto } from '../dto/mark-call.dto';
import { QueryProspectDto } from '../dto/query-prospect.dto';
import { UpdateProspectSettingsDto } from '../dto/update-prospect-settings.dto';

@ApiTags('Prospects (Base de Données)')
@ApiBearerAuth()
@Controller('prospects')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ProspectController {
  constructor(
    private readonly prospectService: ProspectService,
    private readonly scanService: ProspectScanService,
  ) {}

  @Post()
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  @ApiOperation({ summary: 'Saisir un nouveau contact Glovo/Yango (store)' })
  create(@Req() req: Request, @Body() dto: CreateProspectDto) {
    return this.prospectService.create(req.user as User, dto);
  }

  @Post('scan')
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: 'Scanner une capture de commande → champs préremplis (OCR/IA)',
  })
  scan(@UploadedFile() image: Express.Multer.File) {
    if (!image) {
      throw new BadRequestException('Image requise');
    }
    return this.scanService.scan(image.buffer, image.mimetype);
  }

  @Get('check-phone')
  @RequirePermission(Modules.BASE_DONNEES, Action.CREATE)
  @ApiOperation({ summary: 'Vérifier un doublon de téléphone avant saisie' })
  checkPhone(@Req() req: Request, @Query('phone') phone: string) {
    return this.prospectService.checkPhone(req.user as User, phone);
  }

  @Get('call-queue')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: "File d'appels J+1 (call center)" })
  callQueue(@Req() req: Request, @Query('restaurantId') restaurantId?: string) {
    return this.prospectService.getCallQueue(req.user as User, restaurantId);
  }

  @Get('stats')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: 'KPIs + entonnoir + répartition (tableau de bord)' })
  stats(@Req() req: Request, @Query('restaurantId') restaurantId?: string) {
    return this.prospectService.getStats(req.user as User, restaurantId);
  }

  @Get('coupons')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: 'Suivi des coupons émis' })
  coupons(@Req() req: Request, @Query('restaurantId') restaurantId?: string) {
    return this.prospectService.getCoupons(req.user as User, restaurantId);
  }

  @Get('sales')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: 'Ventes générées attribuées' })
  sales(@Req() req: Request, @Query('restaurantId') restaurantId?: string) {
    return this.prospectService.getSales(req.user as User, restaurantId);
  }

  @Get('settings')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Réglages du module (coupon, messages)' })
  getSettings() {
    return this.prospectService.getSettings();
  }

  @Put('settings')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour les réglages' })
  updateSettings(@Body() dto: UpdateProspectSettingsDto) {
    return this.prospectService.updateSettings(dto);
  }

  @Get('export')
  @RequirePermission(Modules.BASE_DONNEES, Action.EXPORT)
  @ApiOperation({ summary: 'Export CSV (type=contacts|coupons|sales)' })
  async export(
    @Req() req: Request,
    @Res() res: Response,
    @Query('type') type = 'contacts',
    @Query('restaurantId') restaurantId?: string,
  ) {
    const csv = await this.prospectService.exportCsv(
      req.user as User,
      type,
      restaurantId,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="prospects-${type}.csv"`,
    );
    res.send('﻿' + csv); // BOM UTF-8 pour Excel
  }

  @Get()
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: 'Liste des contacts (admin), filtrable' })
  findAll(@Req() req: Request, @Query() query: QueryProspectDto) {
    return this.prospectService.findAll(req.user as User, query);
  }

  @Get(':id')
  @RequirePermission(Modules.BASE_DONNEES, Action.READ)
  @ApiOperation({ summary: "Fiche d'un contact + historique" })
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.prospectService.findOne(req.user as User, id);
  }

  @Patch(':id/call')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: "Qualifier un appel (joint / non joignable / refus)" })
  markCall(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: MarkCallDto,
  ) {
    return this.prospectService.markCall(req.user as User, id, dto);
  }

  @Post(':id/coupon')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Générer + envoyer le coupon (après « joint »)' })
  sendCoupon(@Req() req: Request, @Param('id') id: string) {
    return this.prospectService.sendCoupon(req.user as User, id);
  }

  @Post(':id/coupon/resend')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Renvoyer le SMS du coupon existant' })
  resendCoupon(@Req() req: Request, @Param('id') id: string) {
    return this.prospectService.resendCoupon(req.user as User, id);
  }
}
