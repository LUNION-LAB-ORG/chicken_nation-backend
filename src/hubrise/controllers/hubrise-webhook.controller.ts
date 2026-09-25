/**
 * Contrôleur de réception des webhooks HubRise.
 *
 * Endpoint unique :
 * - POST /hubrise/webhook → Reçoit les callbacks de HubRise
 *
 * Sécurité :
 * - Vérification HMAC-SHA256 via le header X-HubRise-Hmac-SHA256 (hexadécimal
 *   du corps brut, clé = client_secret), obligatoire dès qu'un secret existe
 * - Signature absente ou invalide : 401 (HubRise tient tout code 200-499 pour
 *   reçu et ne renvoie pas l'événement)
 * - Sinon 200 OK, y compris sur erreur interne, pour éviter les retries inutiles
 *
 * HubRise retry (réponse 5xx ou délai de 20 s dépassé) : 6 tentatives, attente
 * d'une minute doublée à chaque essai, 32 minutes au plus.
 */

import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { HubriseWebhookService } from '../services/hubrise-webhook.service';
import { HubriseCallbackPayload } from '../interfaces/hubrise-callback.interface';
import { ENTETE_SIGNATURE_HUBRISE } from '../utils/signature-webhook.util';

@Controller('hubrise/webhook')
export class HubriseWebhookController {
  constructor(private readonly webhookService: HubriseWebhookService) {}

  /**
   * Reçoit un callback de HubRise.
   *
   * HubRise envoie un POST avec :
   * - Body : { resource_id, resource_type, event_type, account_id, location_id, timestamp }
   * - Header : X-HubRise-Hmac-SHA256 (signature HMAC-SHA256 en hexadécimal)
   *
   * Signature refusée : 401. Sinon 200 OK pour que HubRise ne retente pas ;
   * les erreurs de traitement sont loguées et gérées en interne.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() payload: HubriseCallbackPayload,
    @Headers(ENTETE_SIGNATURE_HUBRISE) hmacSignature: string | undefined,
    @Req() req: Request,
  ) {
    // Corps brut, OCTETS inchangés, pour la vérification HMAC : rawBody est
    // activé via rawBody: true dans NestFactory.create (main.ts). Rien n'est
    // journalisé avant la vérification (le corps vient de n'importe qui).
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    const ack = await this.webhookService.handleCallback(
      payload,
      hmacSignature,
      rawBody,
    );

    return ack;
  }
}
