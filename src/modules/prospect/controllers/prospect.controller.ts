import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
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
import { UpdateProspectSettingsDto } from '../dto/update-prospect-settings.dto';

@ApiTags('Captures Glovo/Yango')
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

  // ⚠️ Routes de TRANSITION : l'appli caisse pas encore mise à jour s'en sert
  // encore. Appels et coupons passent par le CRM. À retirer (lot 2 bis) quand
  // tous les appareils auront reçu la mise à jour « capture seule ».
  // Lecture réservée au droit UPDATE : un caissier n'a pas à voir les codes promo.
  @Get('call-queue')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: "Ancienne file d'appels J+1 de l'appli caisse (transition)" })
  callQueue(
    @Req() req: Request,
    @Query('restaurantId') restaurantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.prospectService.getCallQueue(
      req.user as User,
      restaurantId,
      startDate,
      endDate,
    );
  }

  @Get('settings')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Réglages du scan de commande (la remise et les messages sont dans le CRM)' })
  getSettings() {
    return this.prospectService.getSettings();
  }

  @Put('settings')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour les réglages du scan' })
  updateSettings(@Body() dto: UpdateProspectSettingsDto) {
    return this.prospectService.updateSettings(dto);
  }

  @Get(':id')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: "Ancienne fiche d'une capture (transition)" })
  findOne(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospectService.findOne(req.user as User, id);
  }

  @Patch(':id/call')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: "Qualifier un appel (joint / non joignable / refus)" })
  markCall(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkCallDto,
  ) {
    return this.prospectService.markCall(req.user as User, id, dto);
  }

  @Post(':id/coupon')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Coupon depuis l’ancienne file (créé et envoyé par le CRM)' })
  sendCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospectService.sendCoupon(req.user as User, id);
  }

  @Post(':id/coupon/resend')
  @RequirePermission(Modules.BASE_DONNEES, Action.UPDATE)
  @ApiOperation({ summary: 'Renvoyer le SMS du coupon existant' })
  resendCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospectService.resendCoupon(req.user as User, id);
  }
}
