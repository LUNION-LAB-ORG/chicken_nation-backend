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
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SchedulePlanStatus, UserRole } from '@prisma/client';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { GeneratePlanDto } from '../dto/generate-plan.dto';
import { RegeneratePlanDto } from '../dto/regenerate-plan.dto';
import { SetDelivererDayDto } from '../dto/set-deliverer-day.dto';
import { SchedulePlanningService } from '../services/schedule-planning.service';
import { ScheduleQueryService } from '../services/schedule-query.service';

/**
 * Endpoints admin du module Schedule.
 * Protégés par JwtAuthGuard + UserRolesGuard (ADMIN uniquement pour P7).
 */
@ApiTags('Schedule — Admin')
@Controller('schedule')
@UseGuards(JwtAuthGuard, UserRolesGuard)
@UserRoles(UserRole.ADMIN)
export class ScheduleAdminController {
  constructor(
    private readonly planningService: SchedulePlanningService,
    private readonly queryService: ScheduleQueryService,
  ) {}

  // ── Plans ────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Liste paginée des plans (filtres par restaurant et statut)',
  })
  @ApiQuery({ name: 'restaurantId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: SchedulePlanStatus })
  @Get('plans')
  async listPlans(
    @Query('restaurantId') restaurantId?: string,
    @Query('status') status?: SchedulePlanStatus,
  ) {
    return this.queryService.listPlans({ restaurantId, status });
  }

  @ApiOperation({
    summary: "Détail d'un plan : shifts + assignments + livreurs",
  })
  @Get('plans/:id')
  async getPlanDetail(@Param('id', new ParseUUIDPipe()) id: string) {
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
  async generatePlan(@Body() dto: GeneratePlanDto) {
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
  async sendPlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.planningService.sendPlan(id);
  }

  @ApiOperation({
    summary: "Confirme un plan SENT (transition CONFIRMED) — fige les snapshots",
  })
  @Patch('plans/:id/confirm')
  async confirmPlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.planningService.confirmPlan(id);
  }

  @ApiOperation({ summary: 'Archive un plan terminé' })
  @Patch('plans/:id/archive')
  async archivePlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.planningService.archivePlan(id);
  }

  @ApiOperation({
    summary: 'Supprime définitivement un plan (DRAFT/SENT/ARCHIVED) — pour le régénérer',
  })
  @Delete('plans/:id')
  async deletePlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.planningService.deletePlan(id);
  }

  @ApiOperation({
    summary: "Édite un jour d'un livreur sur un plan DRAFT (repos ↔ travail)",
  })
  @Patch('plans/:id/deliverers/:delivererId/day')
  async setDelivererDay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('delivererId', new ParseUUIDPipe()) delivererId: string,
    @Body() dto: SetDelivererDayDto,
  ) {
    return this.planningService.setDelivererDayMode(
      id,
      delivererId,
      new Date(dto.date),
      dto.mode,
    );
  }

  @ApiOperation({
    summary:
      'Ajoute un livreur (rattaché après coup) à un plan existant — DRAFT/SENT/CONFIRMED',
  })
  @Post('plans/:id/deliverers/:delivererId')
  async addDeliverer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('delivererId', new ParseUUIDPipe()) delivererId: string,
  ) {
    return this.planningService.addDelivererToPlan(id, delivererId);
  }

  @ApiOperation({
    summary: "Réédite les dates d'un plan (DRAFT/SENT) → régénère un nouveau plan DRAFT",
  })
  @Post('plans/:id/regenerate')
  async regeneratePlan(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RegeneratePlanDto,
  ) {
    return this.planningService.regeneratePlan(
      id,
      new Date(dto.periodStart),
      dto.periodEnd ? new Date(dto.periodEnd) : undefined,
    );
  }

  // ── Stats ────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: "Compteurs en temps réel d'un plan (confirmed / refused / pending)",
  })
  @Get('plans/:id/stats')
  async getPlanStats(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.queryService.countConfirmations(id);
  }
}
