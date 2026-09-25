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

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { verifierSignatureHubrise } from '../utils/signature-webhook.util';

@Injectable()
export class HubriseWebhookService {
  private readonly logger = new Logger(HubriseWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseApi: HubriseApiService,
    private readonly orderSync: HubriseOrderSyncService,
    private readonly customerSync: HubriseCustomerSyncService,
    private readonly config: ConfigService,
  ) {}

  // ─── Traitement des callbacks ──────────────────────────────────────

  /**
   * Traite un callback reçu de HubRise.
   * Vérifie la signature HMAC puis dispatche vers le service approprié.
   *
   * @param payload - Corps du callback
   * @param hmacSignature - Signature reçue dans le header X-HubRise-Hmac-SHA256
   * @param rawBody - Corps brut (octets) pour la vérification HMAC
   * @throws UnauthorizedException si la signature est absente ou invalide
   */
  async handleCallback(
    payload: HubriseCallbackPayload,
    hmacSignature?: string,
    rawBody?: Buffer,
  ): Promise<HubriseCallbackAck> {
    // 1. Vérifier la signature HMAC, AVANT de chercher le restaurant ou d'appeler HubRise
    await this.verifierSignature(hmacSignature, rawBody);

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
            payload.resource_id,
            accessToken,
          );
          break;

        case HUBRISE_CALLBACK_EVENTS.CUSTOMER_CREATE:
        case HUBRISE_CALLBACK_EVENTS.CUSTOMER_UPDATE:
          await this.customerSync.syncCustomerFromHubrise(
            payload.resource_id,
            accessToken,
            payload.location_id,
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
   * ⚠️ Format HubRise pour les événements : objet imbriqué
   *   { "order": ["create", "update"], "customer": ["create"] }
   * et NON un tableau plat comme ["order.create", "order.update"]
   *
   * @param accessToken - Token d'accès HubRise (scopé au location)
   */
  async registerCallback(
    accessToken: string,
  ): Promise<HubriseCallbackResponse | null> {
    this.logger.log('[HubRise Webhook] Enregistrement du callback');

    try {
      const response = await this.hubriseApi.request<HubriseCallbackResponse>({
        method: 'POST',
        url: HUBRISE_CALLBACKS.CREATE,
        accessToken,
        body: {
          url: await this.hubriseApi.getWebhookUrl(),
          events: {
            order: ['create', 'update'],
            customer: ['create', 'update'],
          },
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
   * Supprime le callback HubRise.
   *
   * @param accessToken - Token d'accès HubRise (scopé au location)
   */
  async unregisterCallback(
    accessToken: string,
  ): Promise<void> {
    try {
      await this.hubriseApi.request({
        method: 'DELETE',
        url: HUBRISE_CALLBACKS.DELETE,
        accessToken,
      });

      this.logger.log('[HubRise Webhook] Callback supprimé');
    } catch (error) {
      this.logger.error(`[HubRise Webhook] Erreur suppression callback : ${error}`);
    }
  }

  // ─── Vérification HMAC ─────────────────────────────────────────────

  /**
   * Vérifie la signature HMAC-SHA256 d'un callback HubRise.
   * Clé : le `client_secret` du client OAuth (documentation HubRise, page
   * Callbacks), et non plus `HUBRISE_WEBHOOK_SECRET` que HubRise ignore.
   *
   * Obligatoire dès que ce secret existe : signature absente ou invalide →
   * 401. Seule soupape, explicite : `HUBRISE_WEBHOOK_STRICT=false` accepte le
   * callback en le signalant dans les journaux, le temps de corriger une clé
   * mal renseignée sans perdre les commandes réelles.
   */
  private async verifierSignature(
    signature: string | undefined,
    rawBody: Buffer | undefined,
  ): Promise<void> {
    const secret = await this.hubriseApi.getClientSecret();
    if (!secret) {
      this.logger.warn(
        '[HubRise Webhook] Aucun client_secret HubRise configuré : signature non vérifiée.',
      );
      return;
    }

    if (verifierSignatureHubrise(rawBody, signature, secret)) return;

    const etat = signature ? 'invalide' : 'absente';
    const strict = this.config.get<string>('HUBRISE_WEBHOOK_STRICT') !== 'false';
    if (strict) {
      this.logger.warn(`[HubRise Webhook] Signature ${etat} : callback rejeté.`);
      throw new UnauthorizedException('Signature HubRise invalide');
    }

    this.logger.warn(
      `[HubRise Webhook] Signature ${etat} : callback ACCEPTÉ car HUBRISE_WEBHOOK_STRICT=false. À rétablir au plus vite.`,
    );
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────

  /**
   * Récupère le token d'accès pour un location_id HubRise.
   */
  private async getTokenForLocation(locationId: unknown): Promise<string | null> {
    // ⚠️ Prisma ignore un filtre `undefined` : sans ce contrôle, un corps sans
    // `location_id` renverrait le jeton du PREMIER restaurant venu.
    if (typeof locationId !== 'string' || !locationId) return null;

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { hubrise_location_id: locationId, hubrise_access_token: { not: null } },
      select: { hubrise_access_token: true },
    });

    return restaurant?.hubrise_access_token ?? null;
  }
}
