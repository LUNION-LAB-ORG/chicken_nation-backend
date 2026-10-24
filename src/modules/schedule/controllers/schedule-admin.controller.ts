import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SchedulePlanStatus, User } from '@prisma/client';
import { Request } from 'express';

import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';

import { GeneratePlanDto } from '../dto/generate-plan.dto';
import { RegeneratePlanDto } from '../dto/regenerate-plan.dto';
import { SetDelivererDayDto } from '../dto/set-deliverer-day.dto';
import { MESSAGE_GENERER_AUTRE_RESTAURANT, verifierPlanningDuRestaurant } from '../helpers/planning.rules';
import { ActeurPlanning, SchedulePlanningService } from '../services/schedule-planning.service';
import { ScheduleQueryService } from '../services/schedule-query.service';

/**
 * Planning des livreurs, côté backoffice.
 *
 * Gardé par le droit `Modules.PLANNING` (24/10), plus par une liste de rôles :
 * ADMIN tout, MANAGER et ASSISTANT_MANAGER tout sur LEUR restaurant,
 * LIVRAISON_OPS en lecture. Chaque route porte sa permission : sans elle,
 * `UserPermissionsGuard` laisserait passer.
 *
 * Cloisonnement : liste et aperçu par `resolveRestaurantScope`, génération
 * sur le restaurant du compte, et toute route `:id` lit le restaurant du
 * planning avant d'agir (403 pour un planning d'un autre restaurant).
 */
@ApiTags('Schedule — Admin')
@Controller('schedule')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ScheduleAdminController {
  constructor(
    private readonly planningService: SchedulePlanningService,
    private readonly queryService: ScheduleQueryService,
  ) {}

  // ── Plans ────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Plannings des restaurants : en cours, suivant, livreurs prévus aujourd’hui',
  })
  @ApiQuery({ name: 'restaurantId', required: false })
  @Get('apercu')
  @RequirePermission(Modules.PLANNING, Action.READ)
  async apercu(@Req() req: Request, @Query('restaurantId') restaurantId?: string) {
    return this.queryService.apercu(req.user as User, restaurantId);
  }

  @ApiOperation({
    summary: 'Liste paginée des plans (filtres par restaurant et statut)',
  })
  @ApiQuery({ name: 'restaurantId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: SchedulePlanStatus })
  @Get('plans')
  @RequirePermission(Modules.PLANNING, Action.READ)
  async listPlans(
    @Req() req: Request,
    @Query('restaurantId') restaurantId?: string,
    @Query('status') status?: SchedulePlanStatus,
  ) {
    return this.queryService.listPlans({ restaurantId, status }, 50, req.user as User);
  }

  @ApiOperation({
    summary: "Détail d'un plan : shifts, assignments, livreurs, repos, règles",
  })
  @Get('plans/:id')
  @RequirePermission(Modules.PLANNING, Action.READ)
  async getPlanDetail(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.queryService.getPlanDetail(id);
  }

  @ApiOperation({
    summary: 'Génère automatiquement un plan DRAFT',
    description:
      "Calcule la rotation FIFO des jours de repos + les slots matin/soir " +
      "selon les multiplicateurs de volume. Création atomique en transaction.",
  })
  @ApiBody({ type: GeneratePlanDto })
  @Post('plans/generate')
  @RequirePermission(Modules.PLANNING, Action.CREATE)
  async generatePlan(@Req() req: Request, @Body() dto: GeneratePlanDto) {
    verifierPlanningDuRestaurant(req.user as User, dto.restaurantId, MESSAGE_GENERER_AUTRE_RESTAURANT);
    return this.planningService.generatePlan({
      restaurantId: dto.restaurantId,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
    });
  }

  @ApiOperation({
    summary: 'Envoie un plan DRAFT aux livreurs (transition SENT)',
  })
  @Patch('plans/:id/send')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async sendPlan(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.sendPlan(id);
  }

  @ApiOperation({
    summary: "Confirme un plan SENT (transition CONFIRMED) — fige les snapshots",
  })
  @Patch('plans/:id/confirm')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async confirmPlan(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.confirmPlan(id);
  }

  @ApiOperation({ summary: 'Archive un plan terminé' })
  @Patch('plans/:id/archive')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async archivePlan(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.archivePlan(id);
  }

  @ApiOperation({
    summary: 'Supprime définitivement un plan, dans les quatre états',
  })
  @Delete('plans/:id')
  @RequirePermission(Modules.PLANNING, Action.DELETE)
  async deletePlan(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.deletePlan(id, acteur(req));
  }

  @ApiOperation({
    summary: "Édite un jour d'un livreur (repos ↔ travail), dans les quatre états",
  })
  @Patch('plans/:id/deliverers/:delivererId/day')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async setDelivererDay(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('delivererId', new ParseUUIDPipe()) delivererId: string,
    @Body() dto: SetDelivererDayDto,
  ) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.setDelivererDayMode(
      id,
      delivererId,
      new Date(dto.date),
      dto.mode,
      acteur(req),
    );
  }

  @ApiOperation({
    summary: 'Livreurs actifs du restaurant qui ne sont pas encore sur ce planning',
  })
  @Get('plans/:id/livreurs-ajoutables')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async livreursAjoutables(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.livreursAjoutables(id);
  }

  @ApiOperation({
    summary: 'Ajoute un livreur du restaurant à un plan existant, dans les quatre états',
  })
  @Post('plans/:id/deliverers/:delivererId')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async addDeliverer(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('delivererId', new ParseUUIDPipe()) delivererId: string,
  ) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.addDelivererToPlan(id, delivererId, acteur(req));
  }

  @ApiOperation({
    summary: 'Retire un livreur d’un plan (affectations et repos du planning), dans les quatre états',
  })
  @Delete('plans/:id/deliverers/:delivererId')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async removeDeliverer(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('delivererId', new ParseUUIDPipe()) delivererId: string,
  ) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.removeDelivererFromPlan(id, delivererId, acteur(req));
  }

  @ApiOperation({
    summary: "Réédite les dates d'un plan → régénère un nouveau plan DRAFT, dans les quatre états",
  })
  @Post('plans/:id/regenerate')
  @RequirePermission(Modules.PLANNING, Action.UPDATE)
  async regeneratePlan(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RegeneratePlanDto,
  ) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.planningService.regeneratePlan(
      id,
      new Date(dto.periodStart),
      dto.periodEnd ? new Date(dto.periodEnd) : undefined,
      acteur(req),
    );
  }

  // ── Stats ────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: "Compteurs en temps réel d'un plan (confirmed / refused / pending)",
  })
  @Get('plans/:id/stats')
  @RequirePermission(Modules.PLANNING, Action.READ)
  async getPlanStats(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.queryService.lirePlanAccessible(id, req.user as User);
    return this.queryService.countConfirmations(id);
  }
}

/** Le compte connecté et sa requête, pour la ligne du journal d'audit. */
function acteur(req: Request): ActeurPlanning {
  return {
    user: req.user as User,
    method: (req.method || '').toUpperCase(),
    path: (req.originalUrl || req.url || '').split('?')[0],
  };
}
