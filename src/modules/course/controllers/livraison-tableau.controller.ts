import { Controller, Get, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { User, UserRole } from '@prisma/client';
import type { Request } from 'express';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';

import { TableauLivraisonService } from '../services/tableau-livraison.service';

/**
 * Rôles qui lisent le tableau de la livraison : le siège (administrateur,
 * suivi des livraisons) pour tout le réseau, les comptes de restaurant
 * (manager, assistant, caissière) pour le leur : bandeau du Planning et ligne
 * Livreurs de l'écran Commandes (conception du 24/10, 4.2).
 */
export const ROLES_TABLEAU_LIVRAISON = [
  UserRole.ADMIN,
  UserRole.LIVRAISON_OPS,
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
  UserRole.CAISSIER,
] as const;

/**
 * Tableau de la livraison, en lecture seule. Contrôleur à part
 * (`/livraison`) : sous `/courses`, `tableau` entrerait en collision avec
 * `GET /courses/:id` selon l'ordre de déclaration.
 */
@ApiTags('Livraison (tableau)')
@Controller('livraison')
@UseGuards(JwtAuthGuard, UserRolesGuard)
@UserRoles(...ROLES_TABLEAU_LIVRAISON)
export class LivraisonTableauController {
  constructor(private readonly tableau: TableauLivraisonService) {}

  @ApiOperation({
    summary: 'Tableau de la livraison : chiffres par restaurant, livreurs, alertes',
    description:
      'Par restaurant : livreurs disponibles, en course, en pause, appli fermée, en service, prévus au ' +
      'planning du jour ; courses sans livreur ; livrées et durée moyenne de la journée de service ; ' +
      'nombre d’alertes rouges ; liste des livreurs (état, place dans la file du restaurant, course). ' +
      'Plus `signaux` : alertes calculées par le serveur (TOURNEE_EN_RETARD, SANS_LIVREUR, PARTI_SANS_SAC, ' +
      'COURSE_ANNULEE_A_RELANCER, ATTENTE_AU_RESTAURANT, APPLI_FERMEE_EN_COURSE, POSITION_PERDUE_EN_COURSE, ' +
      'A_ENCAISSER, PREVU_PAS_EN_SERVICE), rouges d’abord. Un compte de restaurant ne reçoit que le sien ; ' +
      'le siège reçoit tout le réseau, ou un restaurant avec `restaurantId`. Gardé 10 s.',
  })
  @ApiQuery({ name: 'restaurantId', required: false, description: 'Siège seulement : un seul restaurant.' })
  @Get('tableau')
  async lire(
    @Req() req: Request,
    @Query('restaurantId', new ParseUUIDPipe({ optional: true })) restaurantId?: string,
  ) {
    return this.tableau.lire(resolveRestaurantScope(req.user as User, restaurantId));
  }
}
