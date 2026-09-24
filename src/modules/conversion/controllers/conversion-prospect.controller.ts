import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import {
  AssignProspectsDto,
  ExportConversionProspectDto,
  QueryConversionProspectDto,
  QueryExportsDto,
  RecordCallDto,
  SendCouponDto,
} from '../dto/prospect.dto';
import { ConversionCallService } from '../services/conversion-call.service';
import { ConversionCouponService } from '../services/conversion-coupon.service';
import { ConversionExportService } from '../services/conversion-export.service';
import { ConversionProspectService } from '../services/conversion-prospect.service';

/**
 * Prospects : inscrits qui n'ont jamais commandé (cahier §4).
 * Les routes fixes précèdent `prospects/:id`, sinon `export` serait lu comme un id.
 */
@ApiTags('Prospects (conversion)')
@ApiBearerAuth()
@Controller('conversion')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ConversionProspectController {
  constructor(
    private readonly prospects: ConversionProspectService,
    private readonly appels: ConversionCallService,
    private readonly coupons: ConversionCouponService,
    private readonly exports: ConversionExportService,
  ) {}

  @Get('prospects')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  @ApiOperation({ summary: 'Liste filtrable (portée : tout pour la direction, son portefeuille pour un agent)' })
  lister(@Req() req: Request, @Query() q: QueryConversionProspectDto) {
    return this.prospects.lister(req.user as User, q);
  }

  @Get('prospects/export')
  @RequirePermission(Modules.PROSPECTS, Action.EXPORT)
  @ApiOperation({ summary: 'Export CSV ou Excel avec les mêmes filtres que la liste' })
  async exporter(@Req() req: Request, @Query() q: ExportConversionProspectDto, @Res() res: Response) {
    const fichier = await this.exports.exporterProspects(req.user as User, q);
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @Patch('prospects/assign')
  @RequirePermission(Modules.PROSPECTS, Action.UPDATE)
  @ApiOperation({ summary: 'Assigner un ou plusieurs prospects à un agent (ou les désassigner)' })
  assigner(@Req() req: Request, @Body() dto: AssignProspectsDto) {
    return this.prospects.assigner(req.user as User, dto);
  }

  @Get('prospects/:id')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  fiche(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.fiche(req.user as User, id);
  }

  @Post('prospects/:id/calls')
  @RequirePermission(Modules.PROSPECTS, Action.UPDATE)
  @ApiOperation({ summary: "Qualifier un appel : statut, raison, commentaire, rappel" })
  appeler(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordCallDto) {
    return this.appels.enregistrer(req.user as User, id, dto);
  }

  @Post('prospects/:id/coupons')
  @RequirePermission(Modules.PROSPECTS, Action.UPDATE)
  @ApiOperation({ summary: 'Créer le coupon et envoyer le message WhatsApp (repli SMS)' })
  envoyerCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendCouponDto) {
    return this.coupons.envoyer(req.user as User, id, dto);
  }

  @Post('prospects/:id/coupons/resend')
  @RequirePermission(Modules.PROSPECTS, Action.UPDATE)
  renvoyerCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.renvoyer(req.user as User, id);
  }

  @Get('my-queue')
  @RequirePermission(Modules.PROSPECTS, Action.UPDATE)
  @ApiOperation({ summary: "File de l'agent connecté, dans l'ordre de traitement" })
  maFile(@Req() req: Request) {
    return this.prospects.maFile(req.user as User);
  }

  @Get('agents')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  agents() {
    return this.prospects.agents();
  }

  @Get('exports')
  @RequirePermission(Modules.PROSPECTS, Action.EXPORT)
  @ApiOperation({ summary: 'Historique des exports (qui, quand, quels filtres)' })
  historiqueExports(@Query() q: QueryExportsDto) {
    return this.exports.historique(q);
  }
}
