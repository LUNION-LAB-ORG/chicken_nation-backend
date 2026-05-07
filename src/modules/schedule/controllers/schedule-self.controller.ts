import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Deliverer } from '@prisma/client';

import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';

import { AddRestDayDto } from '../dto/add-rest-day.dto';
import { PresenceCheckDto } from '../dto/presence-check.dto';
import { RefuseAssignmentDto } from '../dto/refuse-assignment.dto';
import { ScheduleQueryService } from '../services/schedule-query.service';
import { ScheduleSelfService } from '../services/schedule-self.service';

/**
 * Endpoints self-service du livreur sur son planning :
 *   - GET /schedule/me                          → mon planning sur une période
 *   - POST /schedule/me/assignments/:id/accept  → confirmer un shift
 *   - POST /schedule/me/assignments/:id/refuse  → refuser un shift
 *   - POST /schedule/me/rest-days               → ajouter un jour de repos perso
 *   - DELETE /schedule/me/rest-days/:id         → retirer un jour de repos perso
 *   - POST /schedule/me/presence-check          → répondre au check-in matinal
 */
@ApiTags('Schedule — Self')
@Controller('schedule/me')
@UseGuards(JwtDelivererAuthGuard)
export class ScheduleSelfController {
  constructor(
    private readonly queryService: ScheduleQueryService,
    private readonly selfService: ScheduleSelfService,
  ) {}

  @ApiOperation({
    summary: "Mon planning : assignments + jours de repos sur une période",
    description:
      "Si `from`/`to` absents, retourne les 4 prochaines semaines à partir d'aujourd'hui. " +
      "Passer `?includePresenceData=true` pour inclure aussi les check-ins matinaux et " +
      "le nombre de courses traitées par jour (utile pour l'historique).",
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-04-28' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-25' })
  @ApiQuery({ name: 'includePresenceData', required: false, example: 'true' })
  @Get()
  async getMySchedule(
    @CurrentDeliverer() deliverer: Deliverer,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includePresenceData') includePresenceData?: string,
  ) {
    const fromDate = from ? new Date(from) : startOfDay(new Date());
    const toDate = to ? new Date(to) : addDays(fromDate, 28);
    return this.queryService.getDelivererSchedule(
      deliverer.id,
      fromDate,
      toDate,
      includePresenceData === 'true',
    );
  }

  @ApiOperation({ summary: 'Confirmer ma présence sur un shift' })
  @Post('assignments/:id/accept')
  async acceptAssignment(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.selfService.acceptAssignment(deliverer.id, id);
  }

  @ApiOperation({ summary: 'Refuser un shift (avec raison optionnelle)' })
  @ApiBody({ type: RefuseAssignmentDto })
  @Post('assignments/:id/refuse')
  async refuseAssignment(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RefuseAssignmentDto,
  ) {
    return this.selfService.refuseAssignment(deliverer.id, id, dto.reason);
  }

  @ApiOperation({
    summary: 'Ajouter un jour de repos pour moi-même',
    description:
      "Setting `allow_rest_day_override` doit être activé. Si un repos AUTO existe " +
      "déjà pour cette date, il est promu en MANUAL_DELIVERER.",
  })
  @ApiBody({ type: AddRestDayDto })
  @Post('rest-days')
  async addRestDay(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: AddRestDayDto,
  ) {
    return this.selfService.addRestDay(deliverer.id, dto.date, dto.reason);
  }

  @ApiOperation({
    summary: 'Retirer un jour de repos perso',
    description:
      "Ne peut supprimer que les RestDay créés par moi-même (MANUAL_DELIVERER). " +
      "Les MANUAL_ADMIN et AUTO ne sont pas suppressibles côté livreur.",
  })
  @Delete('rest-days/:id')
  async removeRestDay(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.selfService.removeRestDay(deliverer.id, id);
    return { id, deleted: true };
  }

  @ApiOperation({
    summary: 'Répondre au check-in matinal de présence',
    description:
      "Push reçu vers `daily_presence_check_hour` (default 8h). Réponse OUI/NON. " +
      "Si pas de réponse dans la fenêtre, auto-CONFIRMED PRESENT par le cron.",
  })
  @ApiBody({ type: PresenceCheckDto })
  @Post('presence-check')
  async respondPresenceCheck(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: PresenceCheckDto,
  ) {
    return this.selfService.respondPresenceCheck(deliverer.id, dto.response);
  }
}

// ============================================================
// HELPERS
// ============================================================

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
