/**
 * Module d'intégration HubRise.
 *
 * Ce module gère la communication bidirectionnelle entre Chicken Nation et HubRise :
 * - Authentification OAuth 2.0
 * - Réception de commandes via webhooks
 * - Synchronisation du catalogue (plats, catégories, suppléments)
 * - Synchronisation des clients
 * - Mise à jour des statuts de commande
 *
 * Le module est placé en dehors de /modules car c'est une intégration externe,
 * comme Turbo, Twilio, KKiaPay, etc.
 */

import { Module } from '@nestjs/common';

// Contrôleurs
import { HubriseAuthController } from './controllers/hubrise-auth.controller';
import { HubriseWebhookController } from './controllers/hubrise-webhook.controller';
import { HubriseSyncController } from './controllers/hubrise-sync.controller';

// Services
import { HubriseApiService } from './services/hubrise-api.service';
import { HubriseAuthService } from './services/hubrise-auth.service';
import { HubriseOrderSyncService } from './services/hubrise-order-sync.service';
import { HubriseCatalogSyncService } from './services/hubrise-catalog-sync.service';
import { HubriseCustomerSyncService } from './services/hubrise-customer-sync.service';
import { HubriseWebhookService } from './services/hubrise-webhook.service';

@Module({
  controllers: [
    HubriseAuthController,
    HubriseWebhookController,
    HubriseSyncController,
  ],
  providers: [
    HubriseApiService,
    HubriseAuthService,
    HubriseOrderSyncService,
    HubriseCatalogSyncService,
    HubriseCustomerSyncService,
    HubriseWebhookService,
  ],
  exports: [
    HubriseApiService,
    HubriseAuthService,
    HubriseOrderSyncService,
    HubriseCatalogSyncService,
    HubriseCustomerSyncService,
    HubriseWebhookService,
  ],
})
export class HubriseModule {}
