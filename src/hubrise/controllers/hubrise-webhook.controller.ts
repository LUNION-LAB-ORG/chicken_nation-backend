/**
 * Contrôleur de réception des webhooks HubRise.
 *
 * Endpoint unique :
 * - POST /hubrise/webhook → Reçoit les callbacks de HubRise
 *
 * Sécurité :
 * - Vérification HMAC-SHA256 via le header X-HubRise-Hmac
 * - Retourne toujours 200 OK pour éviter les retries inutiles
 *
 * HubRise retry : 6 tentatives avec backoff exponentiel
 * (10s, 30s, 90s, 270s, 810s, 2430s)
 */

import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { HubriseWebhookService } from '../services/hubrise-webhook.service';
import { HubriseCallbackPayload } from '../interfaces/hubrise-callback.interface';

@Controller('hubrise/webhook')
export class HubriseWebhookController {
  private readonly logger = new Logger(HubriseWebhookController.name);

  constructor(private readonly webhookService: HubriseWebhookService) {}

  /**
   * Reçoit un callback de HubRise.
   *
   * HubRise envoie un POST avec :
   * - Body : { resource_id, resource_type, event_type, account_id, location_id, timestamp }
   * - Header : X-HubRise-Hmac (signature HMAC-SHA256)
   *
   * On retourne toujours 200 OK pour que HubRise ne retente pas.
   * Les erreurs sont loguées et gérées en interne.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() payload: HubriseCallbackPayload,
    @Headers('x-hubrise-hmac') hmacSignature: string | undefined,
    @Req() req: Request,
  ) {
    this.logger.log(
      `[HubRise Webhook] Reçu : ${payload.event_type} — ${payload.resource_type}:${payload.resource_id}`,
    );

    // Récupérer le body brut pour la vérification HMAC
    // rawBody est activé via rawBody: true dans NestFactory.create (main.ts)
    const rawBodyBuffer = (req as Request & { rawBody?: Buffer }).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString('utf-8') : undefined;

    const ack = await this.webhookService.handleCallback(
      payload,
      hmacSignature,
      rawBody,
    );

    return ack;
  }
}
