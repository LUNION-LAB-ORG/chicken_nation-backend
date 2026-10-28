import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User, UserRole } from '@prisma/client';
import type { Request } from 'express';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { AssignDelivererDto } from '../dto/assign-deliverer.dto';
import { CancelCourseDto } from '../dto/cancel-course.dto';
import { QueryCourseStatsDto } from '../dto/query-course-stats.dto';
import { QueryCoursesDto } from '../dto/query-courses.dto';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { CourseActionService } from '../services/course-action.service';
import { CourseOfferService } from '../services/course-offer.service';
import { CourseQueryService } from '../services/course-query.service';
import { GardeOffresService } from '../services/garde-offres.service';
import { RelanceLivraisonService } from '../services/relance-livraison.service';
import { ROLES_ACTIONS_COURSES, ROLES_SUIVI_LIVRAISON } from 'src/modules/auth/constantes/roles-suivi-livraison';
import { AppliLivreurService } from 'src/modules/deliverers/services/appli-livreur.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

/**
 * Réponse de l'affectation forcée. L'offre part dans tous les cas (temps réel
 * et notification) ; sans appli connectée, l'admin le sait tout de suite au
 * lieu de croire que le livreur l'a sous les yeux.
 *
 * @param regleAppli  Règle de l'appli fermée active (`deliverer.appli_fermee_apres_s`
 *   au-dessus de 0) : l'affectation n'est passée que pour une appli active, donc
 *   sans socket elle est en arrière-plan (demande du 24/10), rien à demander au
 *   livreur. Règle coupée : l'appli est peut-être fermée.
 */
export function messageAffectationForcee(
  renvoi: boolean,
  appliConnectee: boolean | null,
  regleAppli = false,
): string {
  if (appliConnectee === false) {
    if (regleAppli) {
      return `Offre ${renvoi ? 'renvoyée' : 'envoyée'} par notification : l'appli du livreur est en arrière-plan.`;
    }
    return (
      `Offre ${renvoi ? 'renvoyée' : 'envoyée'} par notification seulement : l'appli du livreur ` +
      "n'est pas connectée en temps réel. Demandez-lui de rouvrir l'appli."
    );
  }
  return renvoi ? 'Offre renvoyée au livreur.' : 'Offre envoyée au livreur.';
}

/**
 * Endpoints admin pour le module course.
 *
 * La classe reste à UserRole.ADMIN (réglages du planificateur). Les lectures
 * s'ouvrent au suivi des livraisons (`ROLES_SUIVI_LIVRAISON`), les gestes sur
 * une course à l'administrateur et au call center (`ROLES_ACTIONS_COURSES`,
 * 26/10). Le garde fait primer la méthode sur la classe.
 */
@ApiTags('Courses — Admin')
@Controller('courses')
@UseGuards(JwtAuthGuard, UserRolesGuard)
@UserRoles(UserRole.ADMIN)
export class CourseAdminController {
  constructor(
    private readonly queryService: CourseQueryService,
    private readonly actionService: CourseActionService,
    private readonly offerService: CourseOfferService,
    private readonly garde: GardeOffresService,
    private readonly gateway: AppGateway,
    private readonly settings: CourseSettingsHelper,
    // Règle de l'appli fermée (demande du 24/10) : réglage lu pour le message.
    private readonly appliLivreur: AppliLivreurService,
    // « Relancer la livraison » d'une livraison annulée par le livreur (28/10).
    private readonly relanceLivraison?: RelanceLivraisonService,
  ) {}

  @ApiOperation({
    summary: 'Planificateur v2 : réglages appliqués et valeurs refusées',
    description:
      'Méthode (`v1` ou `v2`), restaurants concernés (vide = tous), réglages réellement appliqués ' +
      '(défaut si absent ou refusé), et `refusees` : `[{ cle, valeur }]`, chaque valeur saisie mais ' +
      'refusée (hors bornes ou illisible), remplacée par son défaut. Le backoffice la signale.',
  })
  @Get('planificateur/reglages')
  async reglagesPlanificateur() {
    const lue = await this.settings.lirePlanification();
    return {
      version: lue.planificateur.version,
      restaurants: lue.planificateur.restaurants,
      reglages: lue.planification.reglages,
      google: lue.planification.google,
      preparation: lue.preparation.reglages,
      refusees: lue.refusees,
    };
  }

  @ApiOperation({
    summary: 'Liste paginée des courses (toutes)',
    description: 'Code client des livraisons (`delivery_pin`) pour l\'ADMIN seulement.',
  })
  @Get()
  @UserRoles(...ROLES_SUIVI_LIVRAISON)
  async findAll(@Req() req: Request, @Query() query: QueryCoursesDto) {
    return this.queryService.findAllAdmin(query, req.user as User);
  }

  @ApiOperation({
    summary: 'Stats agrégées (KPI + daily breakdown + distribution) pour la page Courses',
  })
  @Get('stats')
  @UserRoles(...ROLES_SUIVI_LIVRAISON)
  async stats(@Query() query: QueryCourseStatsDto) {
    return this.queryService.getStats(query);
  }

  @ApiOperation({
    summary: "Détail d'une course (+ tentatives d'affectation)",
    description: 'Code client des livraisons (`delivery_pin`) pour l\'ADMIN seulement.',
  })
  @Get(':id')
  @UserRoles(...ROLES_SUIVI_LIVRAISON)
  async findOne(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.queryService.findOne(id, req.user as User);
  }

  @ApiOperation({
    summary: 'Forcer l\'affectation à un livreur précis (override admin)',
    description:
      'Même règle que la sélection automatique. 409 avec la raison en français si la course ne ' +
      'cherche plus de livreur, ou si le livreur est en pause, en pause automatique, hors service, ' +
      'en course, a déjà une offre en attente (« Ce livreur est en pause jusqu\'à 14 h 32. »), si ' +
      'son appli est fermée (« L\'appli de ce livreur est fermée. ») ou s\'il est injoignable, ni ' +
      'socket ouvert ni jeton de notification (« Ce livreur est injoignable : ni appli connectée, ni ' +
      'notifications. », réglage `course.offre_joignables_seulement`), ou s\'il est en appel avec ' +
      'le call center (« Ce livreur est en appel avec le call center. »). Les offres d\'autres livreurs ' +
      'sur cette course sont closes. `appli_connectee` : le livreur a-t-il un socket ouvert (false : ' +
      'appli en arrière-plan, l\'offre ne lui arrive que par la notification ; null : inconnu). ' +
      '`appli_active` : vrai (une appli fermée est refusée) ; null si la règle est coupée (réglage à 0).',
  })
  @ApiBody({ type: AssignDelivererDto })
  @Patch(':id/force-assign')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async forceAssign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignDelivererDto,
  ) {
    const { renvoi } = await this.garde.verifierAffectationForcee(id, dto.deliverer_id);
    await this.garde.cloreAutresOffres(id, dto.deliverer_id);
    // forceResend=true : si le livreur a déjà une offer PENDING, on ré-émet le WS
    // plutôt que de silencer — l'admin veut s'assurer que la notif arrive.
    const envoyee = await this.offerService.offerToDeliverer(id, dto.deliverer_id, false, true);
    if (!envoyee) {
      // Les offres des autres livreurs viennent d'être closes : la recherche reprend.
      await this.offerService.offerNextDeliverer(id).catch(() => undefined);
      throw new ConflictException(
        "L'offre n'a pas pu être envoyée : la course ou le livreur vient de changer. Réessayez.",
      );
    }
    const appliConnectee = await this.gateway.livreurConnecte(dto.deliverer_id);
    const regleAppli = await this.appliLivreur.regleActivePour(dto.deliverer_id).catch(() => false);
    return {
      success: true,
      message: messageAffectationForcee(renvoi, appliConnectee, regleAppli),
      appli_connectee: appliConnectee,
      // Règle coupée (réglage à 0) ou appli d'avant le protocole 4 : l'appli est peut-être fermée, état inconnu.
      appli_active: regleAppli ? true : null,
    };
  }

  @ApiOperation({ summary: 'Annuler une course (administrateur, call center)' })
  @ApiBody({ type: CancelCourseDto })
  @Patch(':id/cancel')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelCourseDto,
  ) {
    return this.actionService.cancelCourse(id, 'admin', dto);
  }

  @ApiOperation({
    summary: 'Relancer une course expirée',
    description:
      'Reset les tentatives précédentes (tous les livreurs redeviennent candidats) et relance la recherche.',
  })
  @Patch(':id/retry')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async retry(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.offerService.retryExpiredCourse(id);
    return { success: true, message: 'Course relancée — recherche de livreur en cours' };
  }

  @ApiOperation({
    summary: 'Relancer une course annulée (nouvelle course, nouvelle référence)',
    description:
      "Après une annulation (typiquement par Turbo), crée une NOUVELLE course avec les commandes " +
      "encore actives et relance l'affectation (livreurs internes ou envoi à Turbo selon la flotte). " +
      "La référence est neuve : une referenceCourse déjà envoyée à Turbo n'est jamais réutilisée.",
  })
  @Patch(':id/relancer')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async relancerCourseAnnulee(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.offerService.relancerCourseAnnulee(id);
    return { success: r.ok, message: r.message, newCourseId: r.newCourseId };
  }

  @ApiOperation({
    summary: 'Relancer la livraison annulée par le livreur : elle lui revient, sans passage au restaurant',
    description:
      'Corps vide. Commande à livrer en livraison, livraison en échec (« Annuler » du livreur), course hors Turbo. ' +
      'La même livraison (même code du client) est remise au même livreur : en fin de sa tournée s\'il est en ' +
      'livraison (démarrée seulement si plus rien d\'autre n\'est à livrer), sinon dans une course neuve créée pour ' +
      'lui, directement en livraison, livraison démarrée. Aucune offre, la commande n\'est jamais touchée (paiements, ' +
      'encaissement, points, coupons, ticket). Réponse : `{ order_id, reference, course_id, course_reference, ' +
      'nouvelle_course, rang, demarree, livreur: { id, prenom }, appli_connectee, deja }`. Refus : 404 « Commande ' +
      'introuvable. », 409 « Commande annulée. », 409 « Sac déjà rapporté. », 409 « Aucune livraison annulée sur ' +
      'cette commande. », 409 « Ce livreur va au restaurant pour une autre course : Sac rapporté à son arrivée. », ' +
      '409 avec la raison si le livreur sans course est en pause, en pause automatique, hors service, injoignable, ou ' +
      'inactif. Rejeu (double toucher) : 200 avec `deja: true`, rien n\'est refait.',
  })
  @Post('commandes/:orderId/relancer-livraison')
  @HttpCode(HttpStatus.OK)
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async relancerLivraisonCommande(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.relanceLivraison!.relancer(orderId, req.user as User);
  }

  @ApiOperation({
    summary: 'Confier la course à la flotte externe Turbo',
    description:
      "Bascule manuelle, sans attendre le délai automatique. Utile quand le staff " +
      "sait qu'aucun livreur interne ne se libérera. Course en recherche uniquement.",
  })
  @Patch(':id/turbo')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async basculerVersTurbo(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.offerService.basculerVersTurbo(id);
    return { success: r.ok, message: r.message };
  }

  @ApiOperation({
    summary: 'Reprendre la course en interne (retour depuis Turbo)',
    description:
      "Repropose la course aux livreurs Chicken Nation. Refusé si un livreur Turbo " +
      'a déjà été affecté, pour ne pas envoyer deux livreurs sur la même commande.',
  })
  @Patch(':id/interne')
  @UserRoles(...ROLES_ACTIONS_COURSES)
  async revenirEnInterne(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.offerService.revenirEnInterne(id);
    return { success: r.ok, message: r.message };
  }
}
