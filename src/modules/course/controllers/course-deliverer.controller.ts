import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CourseStatut, Deliverer } from '@prisma/client';

import { TelephoneClientLivreurInterceptor } from 'src/common/securite/telephone-client-livreur.interceptor';
import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';

import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { QueryCoursesDto } from '../dto/query-courses.dto';
import { RateCustomerDto } from '../dto/rate-customer.dto';
import { RefuseOfferDto } from '../dto/refuse-offer.dto';
import { CourseActionService } from '../services/course-action.service';
import { CourseQueryService } from '../services/course-query.service';
import { DeliveryActionService } from '../services/delivery-action.service';
import { DepartCourseService } from '../services/depart-course.service';
import { OffreEnAttenteService } from '../services/offre-en-attente.service';

/**
 * Endpoints livreur pour le module course.
 * Tous protégés par JwtDelivererAuthGuard — scope strict au livreur connecté.
 *
 * Plus de route « annuler la course » ni « colis récupérés » (relecture du
 * 25/10, inutilisées par l'appli depuis mai) : elles ne vérifiaient ni le
 * livreur ni l'état de la course. Le retrait se valide à la caisse (code
 * dicté), une course abandonnée est relancée par l'annulation automatique.
 *
 * Numéro du client : `null` dans toute réponse pour une livraison terminée ou
 * une course close (historique, course rendue après une action, annulation).
 * Pendant la course, il reste là pour que le livreur puisse appeler.
 */
@ApiTags('Courses — Deliverer')
@Controller('courses/deliverer')
@UseGuards(JwtDelivererAuthGuard)
@UseInterceptors(TelephoneClientLivreurInterceptor)
export class CourseDelivererController {
  constructor(
    private readonly actionService: CourseActionService,
    private readonly deliveryService: DeliveryActionService,
    private readonly queryService: CourseQueryService,
    private readonly offreEnAttente: OffreEnAttenteService,
    private readonly depart: DepartCourseService,
  ) {}

  // ============================================================
  // LECTURE
  // ============================================================

  @ApiOperation({ summary: 'Course active du livreur (ACCEPTED / AT_RESTAURANT / IN_DELIVERY)' })
  @Get('me/current')
  async getCurrent(@CurrentDeliverer() deliverer: Deliverer) {
    return this.queryService.getCurrentForDeliverer(deliverer.id);
  }

  @ApiOperation({
    summary: 'Offre en attente du livreur (ou rien)',
    description:
      'Même forme que l\'événement socket `course:offer:new` : `{ offer_id, course, expires_at, ' +
      'is_chain_bonus }`. Corps vide (null) si aucune offre valable. Pour l\'appli ouverte depuis ' +
      'une notification : le socket ne rejoue pas une offre émise pendant qu\'elle était fermée.',
  })
  @Get('me/offre')
  async getOffreEnAttente(@CurrentDeliverer() deliverer: Deliverer) {
    return this.offreEnAttente.pourLivreur(deliverer.id);
  }

  @ApiOperation({ summary: 'Historique des courses du livreur (COMPLETED + CANCELLED + EXPIRED)' })
  @Get('me/history')
  async getHistory(@CurrentDeliverer() deliverer: Deliverer, @Query() query: QueryCoursesDto) {
    return this.queryService.getHistoryForDeliverer(deliverer.id, query);
  }

  // ============================================================
  // OFFER : accepter / refuser
  // ============================================================

  @ApiOperation({
    summary: 'Accepter une offer de course',
    description:
      "409 « Cette course n'est plus disponible. » si l'offre n'est plus en attente (close, échue) " +
      "ou si la course ne cherche plus de livreur (acceptée, fusionnée, annulée, confiée à Turbo) ; " +
      "409 avec la raison si le livreur est en pause ou déjà en course. L'offre est alors close.",
  })
  @Post(':id/accept')
  async accept(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.actionService.acceptOffer(id, deliverer.id);
  }

  @ApiOperation({ summary: 'Refuser une offer de course' })
  @ApiBody({ type: RefuseOfferDto })
  @Post(':id/refuse')
  async refuse(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RefuseOfferDto,
  ) {
    return this.actionService.refuseOffer(id, deliverer.id, dto);
  }

  // ============================================================
  // PHASE RESTAURANT
  // ============================================================

  @ApiOperation({ summary: 'Marquer "arrivé au restaurant"' })
  @Patch(':id/at-restaurant')
  async atRestaurant(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.actionService.markAtRestaurant(id, deliverer.id);
  }

  @ApiOperation({
    summary: 'Je pars : le livreur quitte le restaurant (course récupérée), facultatif',
    description:
      'Ferme la fenêtre d\'ajout après le retrait (`parti_at`). Facultatif : le serveur déduit aussi ' +
      'le départ d\'une position à plus de `course.depart_rayon_m` du restaurant, du démarrage d\'une ' +
      'livraison ou de la fin de la fenêtre. Idempotent. Une commande ajoutée après le retrait et pas ' +
      'encore remise est retirée de la course tout de suite (elle repart dans une autre). Appli au ' +
      'protocole 3 : la première livraison dont la commande est remise est démarrée par le serveur. ' +
      'Rend la course (même forme que `me/current`). 400 si la course n\'est pas encore récupérée.',
  })
  @Post(':id/depart')
  async jePars(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.depart.jePars(id, deliverer.id);
  }

  // ============================================================
  // DELIVERY : par livraison individuelle
  // ============================================================

  @ApiOperation({
    summary: 'Démarrer une livraison (PENDING → IN_ROUTE)',
    description:
      'Déjà en route (démarrée par le serveur au départ) : rendue telle quelle, sans erreur. Course ' +
      'récupérée pas encore partie : le départ est enregistré d\'abord (plus aucun ajout). 409 « Commande ' +
      'pas encore remise. » pour une commande ajoutée après le retrait que la caisse n\'a pas remise. ' +
      '409 « Termine d\'abord le client en cours. » si une autre livraison est en route ou chez son client.',
  })
  @Patch('deliveries/:deliveryId/start')
  async startDelivery(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ) {
    return this.deliveryService.startDelivery(deliveryId, deliverer.id);
  }

  @ApiOperation({ summary: "Marquer 'arrivé chez client'" })
  @Patch('deliveries/:deliveryId/arrived')
  async arrivedDelivery(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ) {
    return this.deliveryService.markArrived(deliveryId, deliverer.id);
  }

  @ApiOperation({ summary: 'Confirmer une livraison via PIN client' })
  @ApiBody({ type: ConfirmDeliveryDto })
  @Patch('deliveries/:deliveryId/confirm')
  async confirmDelivery(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
    @Body() dto: ConfirmDeliveryDto,
  ) {
    return this.deliveryService.confirmDelivery(deliveryId, deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Marquer une livraison en échec',
    description:
      'Seulement une livraison du livreur connecté encore à faire (PENDING, IN_ROUTE, ARRIVED), course ' +
      'en livraison, comme démarrer, arrivé et confirmer : 403 « Cette livraison ne vous est pas ' +
      'affectée » sinon, 400 si la course n\'est pas en livraison ou la livraison déjà terminée. ' +
      'Rejeu (sa livraison déjà en échec : réponse perdue, double toucher) : rendue telle quelle.',
  })
  @ApiBody({ type: FailDeliveryDto })
  @Patch('deliveries/:deliveryId/fail')
  async failDelivery(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
    @Body() dto: FailDeliveryDto,
  ) {
    return this.deliveryService.failDelivery(deliveryId, deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Plus tard : livrer d’abord les autres clients, revenir sur celui-ci à la fin',
    description:
      'Sans corps. La livraison repasse « en attente » (PENDING), va en fin de tournée, son arrivée chez le ' +
      'client est effacée et `reportee_at` est posée ; la suivante démarre aussitôt (une seule transaction). ' +
      'Une fois par livraison, jamais sur la dernière restante. Rend la course complète (même forme que ' +
      '`me/current`). 404 livraison inconnue, 403 autre livreur, 400 course pas en livraison, 409 « Pas encore ' +
      'parti. », 400 livraison terminée, 409 « Déjà reportée une fois. », 409 « Plus d\'autre client. ». Rejeu ' +
      '(déjà reportée, encore en attente) : la course telle quelle.',
  })
  @Patch('deliveries/:deliveryId/plus-tard')
  async plusTard(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ) {
    return this.deliveryService.reporterLivraison(deliveryId, deliverer.id);
  }

  @ApiOperation({ summary: 'Noter le client après une livraison (DELIVERED ou FAILED)' })
  @ApiBody({ type: RateCustomerDto })
  @Post('deliveries/:deliveryId/rate-customer')
  async rateCustomer(
    @CurrentDeliverer() deliverer: Deliverer,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
    @Body() dto: RateCustomerDto,
  ) {
    return this.deliveryService.rateCustomer(deliveryId, deliverer.id, dto);
  }
}
