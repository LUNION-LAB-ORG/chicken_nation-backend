import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { StartCustomerCallDto } from './dto/start-customer-call.dto';
import { AppelsClientService, ClientConnecte } from './services/appels-client.service';

/**
 * Appels dans l'appli Chicken Nation (demande du 26/11) : jeton client
 * seulement. Le personnel passe par CallsController (`/calls`), les livreurs
 * par CallsLivreurController (`/calls/deliverer`).
 *
 * Enregistré AVANT CallsController (voir CallsModule) : `/calls/customer/...`
 * ne doit jamais tomber sur une route `/calls/:id` du personnel.
 */
@Controller('calls/customer')
@UseGuards(JwtCustomerAuthGuard)
export class CallsClientController {
  constructor(private readonly appels: AppelsClientService) {}

  /**
   * Mon appel qui sonne ou en cours (reprise), et le réglage `actif`.
   * `?natif=1` : cette appli sait parler dans l'appli (le service client peut
   * alors m'appeler dans l'appli).
   */
  @Get('active')
  active(@Req() req: Request, @Query('natif') natif?: string) {
    return this.appels.monAppel(req.user as ClientConnecte, natif === '1' || natif === 'true');
  }

  /** J'appelle le service client, ou le livreur de ma commande. */
  @Post()
  start(@Req() req: Request, @Body() dto: StartCustomerCallDto) {
    return this.appels.appeler(req.user as ClientConnecte, dto);
  }

  /** Je décroche l'appel du service client. */
  @Post(':id/answer')
  answer(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.appels.decrocher(req.user as ClientConnecte, id);
  }

  /** Je refuse l'appel du service client. */
  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.appels.refuser(req.user as ClientConnecte, id);
  }

  /** Je raccroche (ou j'annule mon appel qui sonne encore). */
  @Post(':id/hangup')
  hangup(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.appels.raccrocher(req.user as ClientConnecte, id);
  }
}
