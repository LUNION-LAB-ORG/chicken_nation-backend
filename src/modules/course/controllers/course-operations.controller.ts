import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User, UserRole } from '@prisma/client';
import type { Request } from 'express';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { QueryPickupCodeDto, ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseActionService } from '../services/course-action.service';
import { CourseQueryService } from '../services/course-query.service';

/**
 * Endpoints dédiés au flow "Opérations" du backoffice :
 * la caissière / manager du restaurant valide la récupération d'une course
 * en saisissant le pickup_code dicté par le livreur.
 *
 * Accessible à tous les rôles staff du restaurant (pas uniquement ADMIN).
 *
 * Le code n'est unique que dans un restaurant et pour une journée de service
 * (incident du 22/10) : la recherche se fait dans le restaurant du compte
 * connecté, lu dans le JWT, jamais dans la requête. Un compte du siège peut
 * préciser `restaurant_id`.
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
      'Permet à la caissière de visualiser le détail de la course avant de valider (statut des commandes, livreur assigné…). ' +
      "Cherchée dans le restaurant du compte connecté (ou `restaurant_id` pour un compte du siège), parmi les courses de la journée de service.",
  })
  @Get('by-pickup-code/:code')
  async getByPickupCode(
    @Req() req: Request,
    @Param('code') code: string,
    @Query() query: QueryPickupCodeDto,
  ) {
    return this.queryService.findByActivePickupCode(code, req.user as User, query.restaurant_id);
  }

  @ApiOperation({
    summary: "Valide la récupération d'une course par la caissière",
    description:
      "Déclenche la transition AT_RESTAURANT/ACCEPTED → IN_DELIVERY + Orders → PICKED_UP. Échoue si une Order n'est pas encore READY. " +
      'Même recherche que l\'aperçu.',
  })
  @ApiBody({ type: ValidatePickupDto })
  @Post('validate-pickup')
  async validatePickup(@Req() req: Request, @Body() dto: ValidatePickupDto) {
    return this.actionService.validatePickupByCashier(dto, req.user as User);
  }
}
