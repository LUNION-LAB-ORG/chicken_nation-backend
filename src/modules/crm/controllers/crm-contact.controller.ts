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
  AssignContactsDto,
  ExportCrmContactDto,
  QueryCrmContactDto,
  QueryExportsDto,
  RecordCallDto,
  SendCouponDto,
} from '../dto/contact.dto';
import { CrmCallService } from '../services/crm-call.service';
import { CrmCouponService } from '../services/crm-coupon.service';
import { CrmExportService } from '../services/crm-export.service';
import { CrmContactService } from '../services/crm-contact.service';

/**
 * Contacts du CRM (cahier §4) : inscrits sans commande, clients inactifs,
 * clients Glovo et Yango. Les routes fixes précèdent `contacts/:id`, sinon
 * `export` ou `recherche` seraient lus comme un id.
 */
@ApiTags('CRM')
@ApiBearerAuth()
@Controller('crm')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CrmContactController {
  constructor(
    private readonly contacts: CrmContactService,
    private readonly appels: CrmCallService,
    private readonly coupons: CrmCouponService,
    private readonly exports: CrmExportService,
  ) {}

  @Get('contacts')
  @RequirePermission(Modules.CRM, Action.READ)
  @ApiOperation({
    summary:
      'Liste filtrable (portée : tout pour la direction et la consultation, son portefeuille pour un agent ; les fiches de son restaurant pour un compte de point de vente)',
  })
  lister(@Req() req: Request, @Query() q: QueryCrmContactDto) {
    return this.contacts.lister(req.user as User, q);
  }

  @Get('contacts/export')
  @RequirePermission(Modules.CRM, Action.EXPORT)
  @ApiOperation({ summary: 'Export CSV ou Excel avec les mêmes filtres que la liste' })
  async exporter(@Req() req: Request, @Query() q: ExportCrmContactDto, @Res() res: Response) {
    const fichier = await this.exports.exporterContacts(req.user as User, q);
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @Get('contacts/recherche')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: 'Retrouver une fiche par le numéro exact du client (client qui appelle)' })
  rechercher(@Req() req: Request, @Query('telephone') telephone: string) {
    return this.contacts.rechercher(req.user as User, telephone ?? '');
  }

  @Patch('contacts/assign')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: 'Assigner un ou plusieurs contacts à un agent (ou les désassigner)' })
  assigner(@Req() req: Request, @Body() dto: AssignContactsDto) {
    return this.contacts.assigner(req.user as User, dto);
  }

  @Get('contacts/:id')
  @RequirePermission(Modules.CRM, Action.READ)
  @ApiOperation({ summary: 'Fiche du contact ; mode « consultation » pour un lecteur (téléphone compris, aucun geste)' })
  fiche(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Query('telephone') telephone?: string) {
    return this.contacts.fiche(req.user as User, id, telephone);
  }

  @Post('contacts/:id/prendre')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: "Prendre un contact de la file commune Glovo/Yango au moment de l'appeler" })
  prendre(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.prendreContact(req.user as User, id);
  }

  @Post('contacts/:id/calls')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: "Qualifier un appel : statut, raison, commentaire, rappel" })
  appeler(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordCallDto) {
    return this.appels.enregistrer(req.user as User, id, dto);
  }

  @Post('contacts/:id/coupons')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: 'Créer le coupon et envoyer le message WhatsApp (repli SMS)' })
  envoyerCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendCouponDto) {
    return this.coupons.envoyer(req.user as User, id, dto);
  }

  @Post('contacts/:id/coupons/resend')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  renvoyerCoupon(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.renvoyer(req.user as User, id);
  }

  @Get('my-queue')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: "File de l'agent connecté, dans l'ordre de traitement" })
  maFile(@Req() req: Request) {
    return this.contacts.maFile(req.user as User);
  }

  @Get('agents')
  @RequirePermission(Modules.CRM, Action.READ)
  agents(@Req() req: Request) {
    return this.contacts.agents(req.user as User);
  }

  @Get('exports')
  @RequirePermission(Modules.CRM, Action.EXPORT)
  @ApiOperation({ summary: 'Historique des exports (qui, quand, quels filtres)' })
  historiqueExports(@Query() q: QueryExportsDto) {
    return this.exports.historique(q);
  }
}
