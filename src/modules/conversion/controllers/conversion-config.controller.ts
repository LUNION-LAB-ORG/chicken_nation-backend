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
  UpdateConversionSettingsDto,
  UpdateLossReasonDto,
  UpdateOfferDto,
} from '../dto/config.dto';
import { ConversionConfigService } from '../services/conversion-config.service';

/**
 * Listes déroulantes et réglages du module Prospects.
 *
 * Lecture ouverte à qui voit le module (les agents en ont besoin pour
 * qualifier un appel). Écriture exigée en CREATE, pas en UPDATE : les agents
 * ont UPDATE pour traiter leurs prospects, ils ne doivent pas pour autant
 * pouvoir réécrire les listes de tout le monde.
 */
@ApiTags('Prospects (réglages)')
@ApiBearerAuth()
@Controller('conversion')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ConversionConfigController {
  constructor(private readonly config: ConversionConfigService) {}

  // ---------------- Statuts d'appel ----------------

  @Get('call-statuses')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  listerStatuts() {
    return this.config.listerStatutsAppel();
  }

  @Post('call-statuses')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  creerStatut(@Body() dto: CreateCallStatusDto) {
    return this.config.creerStatutAppel(dto);
  }

  @Patch('call-statuses/reorder')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  reordonnerStatuts(@Body() dto: ReorderDto) {
    return this.config.reordonnerStatutsAppel(dto.ids);
  }

  @Patch('call-statuses/:id')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  modifierStatut(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCallStatusDto) {
    return this.config.modifierStatutAppel(id, dto);
  }

  @Delete('call-statuses/:id')
  @RequirePermission(Modules.PROSPECTS, Action.DELETE)
  supprimerStatut(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerStatutAppel(id);
  }

  // ---------------- Raisons de non-commande ----------------

  @Get('loss-reasons')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  listerRaisons() {
    return this.config.listerRaisons();
  }

  @Post('loss-reasons')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  creerRaison(@Body() dto: CreateLossReasonDto) {
    return this.config.creerRaison(dto);
  }

  @Patch('loss-reasons/reorder')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  reordonnerRaisons(@Body() dto: ReorderDto) {
    return this.config.reordonnerRaisons(dto.ids);
  }

  @Patch('loss-reasons/:id')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  modifierRaison(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLossReasonDto) {
    return this.config.modifierRaison(id, dto);
  }

  @Delete('loss-reasons/:id')
  @RequirePermission(Modules.PROSPECTS, Action.DELETE)
  supprimerRaison(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerRaison(id);
  }

  // ---------------- Offres ----------------

  @Get('offers')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  listerOffres() {
    return this.config.listerOffres();
  }

  @Post('offers')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  creerOffre(@Body() dto: CreateOfferDto) {
    return this.config.creerOffre(dto);
  }

  @Patch('offers/:id')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  modifierOffre(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOfferDto) {
    return this.config.modifierOffre(id, dto);
  }

  @Delete('offers/:id')
  @RequirePermission(Modules.PROSPECTS, Action.DELETE)
  supprimerOffre(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.supprimerOffre(id);
  }

  // ---------------- Réglages ----------------

  @Get('settings')
  @RequirePermission(Modules.PROSPECTS, Action.READ)
  lireReglages() {
    return this.config.lireReglages();
  }

  @Patch('settings')
  @RequirePermission(Modules.PROSPECTS, Action.CREATE)
  modifierReglages(@Body() dto: UpdateConversionSettingsDto) {
    return this.config.modifierReglages(dto);
  }
}
