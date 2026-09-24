import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import {
  CreateCallStatusDto,
  CreateLossReasonDto,
  CreateOfferDto,
  ReorderDto,
  UpdateCallStatusDto,
  UpdateCrmSettingsDto,
  UpdateLossReasonDto,
  UpdateOfferDto,
} from '../dto/config.dto';
import { CrmConfigService } from '../services/crm-config.service';

/**
 * Listes déroulantes et réglages du module Contacts.
 *
 * Lecture ouverte à qui voit le module (les agents en ont besoin pour
 * qualifier un appel). Écriture exigée en CREATE, pas en UPDATE : les agents
 * ont UPDATE pour traiter leurs contacts, ils ne doivent pas pour autant
 * pouvoir réécrire les listes de tout le monde.
 */
@ApiTags('Contacts (réglages)')
@ApiBearerAuth()
@Controller('crm')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CrmConfigController {
  constructor(private readonly config: CrmConfigService) {}

  // ---------------- Statuts d'appel ----------------

  @Get('call-statuses')
  @RequirePermission(Modules.CRM, Action.READ)
  listerStatuts() {
    return this.config.listerStatutsAppel();
  }

  @Post('call-statuses')
  @RequirePermission(Modules.CRM, Action.CREATE)
  creerStatut(@Body() dto: CreateCallStatusDto) {
    return this.config.creerStatutAppel(dto);
  }

  @Patch('call-statuses/reorder')
  @RequirePermission(Modules.CRM, Action.CREATE)
  reordonnerStatuts(@Body() dto: ReorderDto) {
    return this.config.reordonnerStatutsAppel(dto.ids);
  }

  @Patch('call-statuses/:id')
  @RequirePermission(Modules.CRM, Action.CREATE)
  modifierStatut(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCallStatusDto) {
    return this.config.modifierStatutAppel(id, dto);
  }

  @Delete('call-statuses/:id')
  @RequirePermission(Modules.CRM, Action.DELETE)
  supprimerStatut(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerStatutAppel(id);
  }

  // ---------------- Raisons de non-commande ----------------

  @Get('reasons')
  @RequirePermission(Modules.CRM, Action.READ)
  listerRaisons() {
    return this.config.listerRaisons();
  }

  @Post('reasons')
  @RequirePermission(Modules.CRM, Action.CREATE)
  creerRaison(@Body() dto: CreateLossReasonDto) {
    return this.config.creerRaison(dto);
  }

  @Patch('reasons/reorder')
  @RequirePermission(Modules.CRM, Action.CREATE)
  reordonnerRaisons(@Body() dto: ReorderDto) {
    return this.config.reordonnerRaisons(dto.ids);
  }

  @Patch('reasons/:id')
  @RequirePermission(Modules.CRM, Action.CREATE)
  modifierRaison(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLossReasonDto) {
    return this.config.modifierRaison(id, dto);
  }

  @Delete('reasons/:id')
  @RequirePermission(Modules.CRM, Action.DELETE)
  supprimerRaison(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerRaison(id);
  }

  // ---------------- Offres ----------------

  @Get('offers')
  @RequirePermission(Modules.CRM, Action.READ)
  listerOffres() {
    return this.config.listerOffres();
  }

  @Post('offers')
  @RequirePermission(Modules.CRM, Action.CREATE)
  creerOffre(@Body() dto: CreateOfferDto) {
    return this.config.creerOffre(dto);
  }

  @Patch('offers/:id')
  @RequirePermission(Modules.CRM, Action.CREATE)
  modifierOffre(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOfferDto) {
    return this.config.modifierOffre(id, dto);
  }

  @Delete('offers/:id')
  @RequirePermission(Modules.CRM, Action.DELETE)
  supprimerOffre(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerOffre(id);
  }

  // ---------------- Réglages ----------------

  @Get('settings')
  @RequirePermission(Modules.CRM, Action.READ)
  lireReglages() {
    return this.config.lireReglages();
  }

  @Patch('settings')
  @RequirePermission(Modules.CRM, Action.CREATE)
  modifierReglages(@Body() dto: UpdateCrmSettingsDto) {
    return this.config.modifierReglages(dto);
  }
}
