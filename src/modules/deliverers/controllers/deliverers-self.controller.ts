import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Deliverer } from '@prisma/client';

import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';

import { PauseDelivererDto } from '../dto/pause-deliverer.dto';
import { RegisterExpoPushTokenDto } from '../dto/register-expo-push-token.dto';
import { SetHomeLocationDto } from '../dto/set-home-location.dto';
import { UpdateDelivererLocationDto } from '../dto/update-location.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { DelivererInfoService } from '../services/deliverer-info.service';
import { DelivererRewardsService } from '../services/deliverer-rewards.service';
import { DeliverersService } from '../services/deliverers.service';
import { DisponibiliteLivreurService } from '../services/disponibilite-livreur.service';

/**
 * Endpoints consommés par le livreur lui-même (mobile).
 * Pas de DelivererOperationalGuard : même un livreur PENDING_VALIDATION
 * doit pouvoir compléter / corriger son profil et ses documents.
 */
@ApiTags('Deliverers — Self')
@Controller('deliverers/me')
@UseGuards(JwtDelivererAuthGuard)
export class DeliverersSelfController {
  constructor(
    private readonly deliverersService: DeliverersService,
    private readonly delivererInfoService: DelivererInfoService,
    private readonly rewardsService: DelivererRewardsService,
    private readonly disponibilite: DisponibiliteLivreurService,
  ) {}

  @ApiOperation({ summary: 'Profil livreur connecté' })
  @Get()
  async getMe(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.findOne(deliverer.id);
  }

  @ApiOperation({
    summary: 'Resoumettre sa demande après un refus (REJECTED → PENDING_VALIDATION)',
    description:
      "Après correction de ses informations/documents, le livreur refusé resoumet " +
      "sa candidature pour une nouvelle validation par un administrateur.",
  })
  @Post('resubmit')
  async resubmit(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.resubmit(deliverer.id);
  }

  @ApiOperation({ summary: "Définir le lieu d'habitation (domicile) du livreur" })
  @Post('home-location')
  async setHomeLocation(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: SetHomeLocationDto,
  ) {
    return this.deliverersService.setHomeLocation(deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Vue scoring + queue + refus + pause du livreur connecté',
    description:
      "Agrège tous les champs calculés par le scoring P4 / queue P5 / chainage P6 : " +
      'rang dans la file, score composite + breakdown, pénalités glissantes, auto-pause, ' +
      'raisons humaines pour expliquer le statut courant. Consommé par le mobile pour ' +
      'afficher la card "Mon score & ma file" sur l\'écran d\'accueil.',
  })
  @Get('scoring-info')
  async getMyScoringInfo(@CurrentDeliverer() deliverer: Deliverer) {
    return this.delivererInfoService.getScoringInfo(deliverer.id);
  }

  @ApiOperation({
    summary: 'Récompenses (XP + niveaux) du livreur connecté',
    description:
      'XP cumulés depuis la création du compte, calculés on-the-fly à partir des ' +
      'livraisons (DELIVERED +100, FAILED +20, +50 si le livreur a noté le client). ' +
      'Retourne aussi le statut de chaque niveau (débloqué / en cours / verrouillé) ' +
      'et le bonus FCFA associé. Consommé par /recompenses (ProgressRing + NiveauCard).',
  })
  @Get('rewards')
  async getMyRewards(@CurrentDeliverer() deliverer: Deliverer) {
    return this.rewardsService.getRewards(deliverer.id);
  }

  @ApiOperation({ summary: 'Mise à jour du profil livreur' })
  @ApiBody({ type: UpdateProfileDto })
  @Patch()
  async updateSelf(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.deliverersService.updateSelf(deliverer.id, dto);
  }

  @ApiOperation({ summary: 'Upload avatar (champ multipart: image)' })
  @ApiConsumes('multipart/form-data')
  @Post('image')
  @UseInterceptors(FileInterceptor('image'))
  async uploadImage(
    @CurrentDeliverer() deliverer: Deliverer,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.deliverersService.uploadDocument(deliverer.id, file, 'image');
  }

  @ApiOperation({ summary: "Upload pièce d'identité (champ multipart: file)" })
  @ApiConsumes('multipart/form-data')
  @Post('piece-identite')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPieceIdentite(
    @CurrentDeliverer() deliverer: Deliverer,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.deliverersService.uploadDocument(deliverer.id, file, 'piece_identite');
  }

  @ApiOperation({ summary: 'Upload permis de conduire (champ multipart: file)' })
  @ApiConsumes('multipart/form-data')
  @Post('permis-conduire')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPermisConduire(
    @CurrentDeliverer() deliverer: Deliverer,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.deliverersService.uploadDocument(deliverer.id, file, 'permis_conduire');
  }

  // ============================================================
  // GÉOLOCALISATION & DISPONIBILITÉ
  // ============================================================

  @ApiOperation({
    summary: 'Remonte la position GPS + vitesse + cap du livreur',
    description:
      "Appelé par l'app mobile toutes les `deliverer.gps_update_interval_seconds` " +
      '(default 60s) quand le livreur est en ligne. Validation de vitesse côté backend. ' +
      "Chaque position est un signe de vie (`dernier_signal_at`) : envoyée par la tâche " +
      "d'arrière-plan, elle garde l'appli active (offres reçues) tant qu'elle arrive moins de " +
      '`deliverer.appli_fermee_apres_s` secondes après la précédente.',
  })
  @ApiBody({ type: UpdateDelivererLocationDto })
  @Post('location')
  async updateLocation(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: UpdateDelivererLocationDto,
  ) {
    return this.deliverersService.updateLocation(deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Met le livreur en pause (bouton "Je prends une pause")',
    description:
      '`durationMinutes` optionnel : si absent, pause jusqu\'à « Reprendre ». Sort de la file ' +
      'et clôt les offres en attente, sans pénalité (`course:offer:expired`, recherche relancée).',
  })
  @ApiBody({ type: PauseDelivererDto })
  @Post('pause')
  async pause(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: PauseDelivererDto,
  ) {
    return this.disponibilite.mettreEnPause(deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Sort de la pause MANUELLE (premier appel de « Reprendre »)',
    description:
      'Ne lève jamais une pause automatique : 409 « Pause automatique jusqu\'à 14 h 32. ». ' +
      'Ne remet PAS dans la file : le livreur appelle ensuite `/available`.',
  })
  @Post('resume')
  async resume(@CurrentDeliverer() deliverer: Deliverer) {
    return this.disponibilite.reprendre(deliverer.id);
  }

  @ApiOperation({
    summary: 'Entrée dans la file (prêt à recevoir des offres)',
    description:
      'Ne lève JAMAIS une pause : pendant une pause ou une pause automatique, rien ne change et ' +
      'la réponse est 200 `{ en_pause: true, pause_until, auto_pause_until }`. Sinon ' +
      '`last_available_at` est posé s\'il était vide : le livreur garde sa place dans la file.',
  })
  @Post('available')
  @HttpCode(HttpStatus.OK)
  async markAvailable(@CurrentDeliverer() deliverer: Deliverer) {
    return this.disponibilite.marquerDisponible(deliverer.id);
  }

  @ApiOperation({
    summary: 'Enregistre le token Expo Push du livreur (P-chat livreur)',
    description:
      "Appelé par le mobile au login + à chaque renouvellement de token. Permet d'envoyer " +
      'des notifications push (nouveau message support, nouvelle course, auto-pause, etc.) ' +
      'même app fermée.',
  })
  @ApiBody({ type: RegisterExpoPushTokenDto })
  @Post('expo-push-token')
  async registerExpoPushToken(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: RegisterExpoPushTokenDto,
  ) {
    return this.deliverersService.registerExpoPushToken(deliverer.id, dto.token);
  }

  @ApiOperation({
    summary: 'Sortie file d\'attente (sans être en pause stricto sensu)',
    description:
      "Utilisé automatiquement à l'acceptation d'une offre (livreur devient \"en activité\").",
  })
  @Post('unavailable')
  async markUnavailable(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.markUnavailable(deliverer.id);
  }
}
