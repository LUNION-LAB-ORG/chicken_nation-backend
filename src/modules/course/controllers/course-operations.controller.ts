import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User, UserRole } from '@prisma/client';
import type { Request } from 'express';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { ConfirmerRecuperationDto } from '../dto/confirmer-recuperation.dto';
import { QueryPickupCodeDto, ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseActionService } from '../services/course-action.service';
import { CourseQueryService } from '../services/course-query.service';
import { SacRapporteService } from '../services/sac-rapporte.service';

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
 *
 * Depuis le 24/10 (conception, 11.1), l'écran Commandes ne saisit plus le
 * code : la caissière touche le groupe de la course et confirme. Routes par
 * identifiant (`GET :id`, `POST :id/recuperation`), cloisonnées au restaurant
 * de la course. Les routes à code restent (caisse Sunmi, repli de l'écran).
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
    // « Sac rapporté » (28/10).
    private readonly sacRapporteService?: SacRapporteService,
  ) {}

  @ApiOperation({
    summary: 'Sac rapporté : la commande dont le livreur a annulé la livraison redevient prête',
    description:
      'Corps vide. Commande à livrer en livraison, livraison en échec (« Annuler » du livreur), course non confiée à ' +
      'Turbo : la commande repasse READY (claim atomique), la livraison annulée est copiée au journal (SAC_RAPPORTE) ' +
      'puis supprimée, les frais de l\'ancienne course recalculés, dans une transaction. Le planificateur la reprend ' +
      'au passage suivant dans une nouvelle course. Paiements, encaissements, points, coupons et ticket ne bougent pas. ' +
      'Réponse : `{ order_id, reference, status, livreur, deja }`. Refus : 404 « Commande introuvable. », 403 « Cette ' +
      'commande n\'est pas celle de votre restaurant. », 409 « Commande annulée. », 409 « Pas de sac à rapporter pour ' +
      'cette commande. ». Rejeu : 200 avec `deja: true`, rien n\'est refait.',
  })
  @Post('commandes/:orderId/sac-rapporte')
  async sacRapporte(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.sacRapporteService!.sacRapporte(orderId, req.user as User);
  }

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

  @ApiOperation({
    summary: 'Aperçu de la course à remettre, par son identifiant',
    description:
      'Même course et même forme que l\'aperçu par code. 404 « Course introuvable. » (inconnue ou d\'un autre jour), ' +
      '403 si la course est celle d\'un autre restaurant (compte de restaurant), 409 si elle n\'est plus à remettre ' +
      'ou si aucun livreur ne l\'a encore acceptée.',
  })
  @Get(':id')
  async apercuParId(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.queryService.findARemettreParId(id, req.user as User);
  }

  @ApiOperation({
    summary: 'Confirme la récupération d\'une course par la caissière, sans code',
    description:
      'Les commandes de `order_ids` passent PICKED_UP (retrait normal : toutes les commandes de la course doivent être prêtes ; ' +
      'retrait complémentaire et sac oublié : les commandes prêtes). Mêmes refus que l\'aperçu ; 409 « Cette course ' +
      'vient de changer : la remise n\'est pas enregistrée, vérifiez les commandes et validez à nouveau. » si une ' +
      'commande envoyée n\'est plus dans la course ; 409 si la course ' +
      'vient d\'être remise (double confirmation). Renvoie la course remise.',
  })
  @ApiBody({ type: ConfirmerRecuperationDto })
  @Post(':id/recuperation')
  async confirmerRecuperation(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmerRecuperationDto,
  ) {
    return this.actionService.confirmerRecuperation(id, dto.order_ids, req.user as User);
  }
}
