import {
  Body,
  Controller,
  Get,
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
import { UpdateDelivererLocationDto } from '../dto/update-location.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { DelivererInfoService } from '../services/deliverer-info.service';
import { DelivererRewardsService } from '../services/deliverer-rewards.service';
import { DeliverersService } from '../services/deliverers.service';

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
  ) {}

  @ApiOperation({ summary: 'Profil livreur connecté' })
  @Get()
  async getMe(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.findOne(deliverer.id);
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
      '(default 60s) quand le livreur est en ligne. Validation de vitesse côté backend.',
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
      '`durationMinutes` optionnel : si absent, pause indéfinie jusqu\'à appel de `/resume`.',
  })
  @ApiBody({ type: PauseDelivererDto })
  @Post('pause')
  async pause(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: PauseDelivererDto,
  ) {
    return this.deliverersService.pauseDeliverer(deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Sort de pause (manuelle ou forcée)',
    description:
      "Ne remet PAS automatiquement en queue. Le livreur doit ensuite appeler `/available`.",
  })
  @Post('resume')
  async resume(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.resumeDeliverer(deliverer.id);
  }

  @ApiOperation({
    summary: 'Entrée file d\'attente FIFO (prêt à recevoir des offres)',
    description:
      'À appeler après une connexion, fin de pause, ou fin de course. `last_available_at = now`.',
  })
  @Post('available')
  async markAvailable(@CurrentDeliverer() deliverer: Deliverer) {
    return this.deliverersService.markAvailable(deliverer.id);
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
