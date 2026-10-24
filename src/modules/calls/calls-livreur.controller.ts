import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';
import { StartDelivererCallDto } from './dto/start-deliverer-call.dto';
import { AppelsLivreurService, LivreurConnecte } from './services/appels-livreur.service';

/**
 * Appels dans l'appli du livreur (demande du 24/10) : jeton livreur seulement.
 * Le personnel passe par CallsController (`/calls`, jeton du personnel).
 *
 * Enregistré AVANT CallsController (voir CallsModule) : `/calls/deliverer/...`
 * ne doit jamais tomber sur une route `/calls/:id` du personnel.
 */
@Controller('calls/deliverer')
@UseGuards(JwtDelivererAuthGuard)
export class CallsLivreurController {
  constructor(private readonly appels: AppelsLivreurService) {}

  /** Mon appel qui sonne ou en cours (reprise), et le réglage `actif`. */
  @Get('active')
  active(@CurrentDeliverer() livreur: LivreurConnecte) {
    return this.appels.monAppel(livreur);
  }

  /** J'appelle le service client. */
  @Post()
  start(@CurrentDeliverer() livreur: LivreurConnecte, @Body() dto: StartDelivererCallDto) {
    return this.appels.appelerServiceClient(livreur, dto);
  }

  /** Je décroche l'appel du service client. */
  @Post(':id/answer')
  answer(@Param('id', ParseUUIDPipe) id: string, @CurrentDeliverer() livreur: LivreurConnecte) {
    return this.appels.decrocher(livreur, id);
  }

  /** Je refuse l'appel du service client. */
  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentDeliverer() livreur: LivreurConnecte) {
    return this.appels.refuser(livreur, id);
  }

  /** Je raccroche (ou j'annule mon appel qui sonne encore). */
  @Post(':id/hangup')
  hangup(@Param('id', ParseUUIDPipe) id: string, @CurrentDeliverer() livreur: LivreurConnecte) {
    return this.appels.raccrocher(livreur, id);
  }
}
