import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseActionService } from '../services/course-action.service';
import { CourseQueryService } from '../services/course-query.service';

/**
 * Endpoints dédiés au flow "Opérations" du backoffice :
 * la caissière / manager du restaurant valide la récupération d'une course
 * en saisissant le pickup_code dicté par le livreur.
 *
 * Accessible à tous les rôles staff du restaurant (pas uniquement ADMIN).
 */
@ApiTags('Courses — Opérations (caissière)')
@Controller('courses/operations')
@UseGuards(JwtAuthGuard, UserRolesGuard)
@UserRoles(
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
  UserRole.CAISSIER,
)
export class CourseOperationsController {
  constructor(
    private readonly queryService: CourseQueryService,
    private readonly actionService: CourseActionService,
  ) {}

  @ApiOperation({
    summary: "Récupère la course active (preview) correspondant à un code de retrait",
    description:
      'Permet à la caissière de visualiser le détail de la course avant de valider (statut des commandes, livreur assigné…).',
  })
  @Get('by-pickup-code/:code')
  async getByPickupCode(@Param('code') code: string) {
    const course = await this.queryService.findByActivePickupCode(code);
    if (!course) {
      throw new NotFoundException('Aucune course active pour ce code de retrait');
    }
    return course;
  }

  @ApiOperation({
    summary: "Valide la récupération d'une course par la caissière",
    description:
      "Déclenche la transition AT_RESTAURANT/ACCEPTED → IN_DELIVERY + Orders → PICKED_UP. Échoue si une Order n'est pas encore READY.",
  })
  @ApiBody({ type: ValidatePickupDto })
  @Post('validate-pickup')
  async validatePickup(@Body() dto: ValidatePickupDto) {
    return this.actionService.validatePickupByCashier(dto);
  }
}
