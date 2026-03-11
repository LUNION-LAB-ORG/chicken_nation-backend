/**
 * Service de gestion des webhooks (callbacks) HubRise.
 *
 * Gère :
 * - La réception et la vérification des callbacks HubRise
 * - Le dispatch vers les services de synchronisation appropriés
 * - L'enregistrement/désenregistrement des callbacks auprès de HubRise
 * - La vérification HMAC-SHA256 des payloads
 *
 * Événements supportés :
 * - order.create : Nouvelle commande reçue depuis un canal HubRise
 * - order.update : Mise à jour de statut d'une commande
 * - customer.create : Nouveau client
 * - customer.update : Mise à jour d'un client
 *
 * Documentation : https://developers.hubrise.com/api/callbacks
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from 'src/database/services/prisma.service';
import { HubriseApiService } from './hubrise-api.service';
import { HubriseOrderSyncService } from './hubrise-order-sync.service';
import { HubriseCustomerSyncService } from './hubrise-customer-sync.service';
import { HUBRISE_CALLBACKS } from '../constants/hubrise-endpoints.constant';
import { HUBRISE_CALLBACK_EVENTS } from '../constants/hubrise-status-mapping.constant';
import {
  HubriseCallbackPayload,
  HubriseCallbackAck,
  HubriseCallbackResponse,
} from '../interfaces/hubrise-callback.interface';

@Injectable()
export class HubriseWebhookService {
  private readonly logger = new Logger(HubriseWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseApi: HubriseApiService,
    private readonly orderSync: HubriseOrderSyncService,
    private readonly customerSync: HubriseCustomerSyncService,
  ) {}

  // ─── Traitement des callbacks ──────────────────────────────────────

  /**
   * Traite un callback reçu de HubRise.
   * Vérifie la signature HMAC puis dispatche vers le service approprié.
   *
   * @param payload - Corps du callback
   * @param hmacSignature - Signature HMAC reçue dans le header X-HubRise-Hmac
   * @param rawBody - Corps brut pour la vérification HMAC
   */
  async handleCallback(
    payload: HubriseCallbackPayload,
    hmacSignature?: string,
    rawBody?: string,
  ): Promise<HubriseCallbackAck> {
    // 1. Vérifier la signature HMAC (si le secret est configuré)
    if (this.hubriseApi.webhookSecret && hmacSignature && rawBody) {
      if (!this.verifyHmac(rawBody, hmacSignature)) {
        this.logger.warn('[HubRise Webhook] Signature HMAC invalide — callback rejeté');
        return { received: false, message: 'Signature HMAC invalide' };
      }
    }

    this.logger.log(
      `[HubRise Webhook] Callback reçu : ${payload.event_type} pour ${payload.resource_type} ${payload.resource_id}`,
    );

    // 2. Récupérer le token du restaurant correspondant au location_id
    const accessToken = await this.getTokenForLocation(payload.location_id);
    if (!accessToken) {
      this.logger.error(
        `[HubRise Webhook] Aucun token trouvé pour le location ${payload.location_id}`,
      );
      return { received: true, message: 'Location non connecté' };
    }

    // 3. Dispatcher vers le bon service selon l'événement
    try {
      switch (payload.event_type) {
        case HUBRISE_CALLBACK_EVENTS.ORDER_CREATE:
        case HUBRISE_CALLBACK_EVENTS.ORDER_UPDATE:
          await this.orderSync.syncOrderFromHubrise(
            payload.location_id,
            payload.resource_id,
            accessToken,
          );
          break;

        case HUBRISE_CALLBACK_EVENTS.CUSTOMER_CREATE:
        case HUBRISE_CALLBACK_EVENTS.CUSTOMER_UPDATE:
          await this.customerSync.syncCustomerFromHubrise(
            payload.location_id,
            payload.resource_id,
            accessToken,
          );
          break;

        default:
          this.logger.debug(
            `[HubRise Webhook] Événement non géré : ${payload.event_type}`,
          );
      }

      return { received: true };
    } catch (error) {
      this.logger.error(`[HubRise Webhook] Erreur traitement callback : ${error}`);
      // Retourner 200 quand même pour éviter les retries HubRise inutiles
      // (l'erreur est loguée pour investigation)
      return { received: true, message: 'Erreur interne, callback traité avec erreur' };
    }
  }

  // ─── Enregistrement des callbacks ──────────────────────────────────

  /**
   * Enregistre le webhook callback auprès de HubRise pour un restaurant.
   * Appelé après la connexion OAuth d'un restaurant.
   *
   * @param locationId - ID du location HubRise
   * @param accessToken - Token d'accès HubRise
   */
  async registerCallback(
    locationId: string,
    accessToken: string,
  ): Promise<HubriseCallbackResponse | null> {
    this.logger.log(`[HubRise Webhook] Enregistrement callback pour location ${locationId}`);

    try {
      const response = await this.hubriseApi.request<HubriseCallbackResponse>({
        method: 'POST',
        url: HUBRISE_CALLBACKS.CREATE(locationId),
        accessToken,
        body: {
          url: this.hubriseApi.webhookUrl,
          events: [
            HUBRISE_CALLBACK_EVENTS.ORDER_CREATE,
            HUBRISE_CALLBACK_EVENTS.ORDER_UPDATE,
            HUBRISE_CALLBACK_EVENTS.CUSTOMER_CREATE,
            HUBRISE_CALLBACK_EVENTS.CUSTOMER_UPDATE,
          ],
        },
      });

      this.logger.log(
        `[HubRise Webhook] Callback enregistré : ${response.id}`,
      );

      return response;
    } catch (error) {
      this.logger.error(`[HubRise Webhook] Erreur enregistrement callback : ${error}`);
      return null;
    }
  }

  /**
   * Supprime un callback HubRise.
   *
   * @param locationId - ID du location HubRise
   * @param callbackId - ID du callback à supprimer
   * @param accessToken - Token d'accès HubRise
   */
  async unregisterCallback(
    locationId: string,
    callbackId: string,
    accessToken: string,
  ): Promise<void> {
    try {
      await this.hubriseApi.request({
        method: 'DELETE',
        url: HUBRISE_CALLBACKS.DELETE(locationId, callbackId),
        accessToken,
      });

      this.logger.log(`[HubRise Webhook] Callback ${callbackId} supprimé`);
    } catch (error) {
      this.logger.error(`[HubRise Webhook] Erreur suppression callback : ${error}`);
    }
  }

  // ─── Vérification HMAC ─────────────────────────────────────────────

  /**
   * Vérifie la signature HMAC-SHA256 d'un callback HubRise.
   * Le secret est fourni lors de la création du callback.
   *
   * @param rawBody - Corps brut de la requête
   * @param signature - Signature reçue dans le header X-HubRise-Hmac
   * @returns true si la signature est valide
   */
  private verifyHmac(rawBody: string, signature: string): boolean {
    const secret = this.hubriseApi.webhookSecret;
    if (!secret) return true; // Pas de vérification si pas de secret

    const expectedSignature = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    return expectedSignature === signature;
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────

  /**
   * Récupère le token d'accès pour un location_id HubRise.
   */
  private async getTokenForLocation(locationId: string): Promise<string | null> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { hubrise_location_id: locationId },
      select: { hubrise_access_token: true },
    });

    return restaurant?.hubrise_access_token ?? null;
  }
}
