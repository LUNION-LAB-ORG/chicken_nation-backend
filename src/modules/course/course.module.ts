import { Module } from '@nestjs/common';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';
import { MapsModule } from 'src/modules/maps/maps.module';
import { TurboModule } from 'src/turbo/turbo.module';

import { CourseAdminController } from './controllers/course-admin.controller';
import { CourseDelivererController } from './controllers/course-deliverer.controller';
import { CourseOperationsController } from './controllers/course-operations.controller';
import { CourseEvent } from './events/course.event';
import { CourseHelper } from './helpers/course.helper';
import { CourseSettingsHelper } from './helpers/course-settings.helper';
import { CourseListenerService } from './listeners/course.listener.service';
import { DispatchListener } from './listeners/dispatch.listener';
import { OrderBridgeListenerService } from './listeners/order-bridge.listener.service';
import { RemiseCaisseListener } from './listeners/remise-caisse.listener';
import { AnnulationAutoService } from './services/annulation-auto.service';
import { CourseActionService } from './services/course-action.service';
import { CourseEnLivraisonService } from './services/course-en-livraison.service';
import { CourseGroupingService } from './services/course-grouping.service';
import { CourseOfferService } from './services/course-offer.service';
import { CourseQueryService } from './services/course-query.service';
import { DeliveryActionService } from './services/delivery-action.service';
import { DeliveryTrackingService } from './services/delivery-tracking.service';
import { GardeOffresService } from './services/garde-offres.service';
import { OffreEnAttenteService } from './services/offre-en-attente.service';
import { CourseBatchTask } from './tasks/course-batch.task';
import { CourseTask } from './tasks/course.task';
import { CourseWebSocketService } from './websockets/course-websocket.service';

@Module({
  // TurboModule : bascule vers la flotte externe quand la flotte interne est saturée.
  // MapsModule : ETA client (trafic + arrêts) dans le suivi de livraison.
  imports: [AuthDelivererModule, DeliverersModule, TurboModule, MapsModule],
  controllers: [CourseDelivererController, CourseAdminController, CourseOperationsController],
  providers: [
    // Helpers
    CourseHelper,
    CourseSettingsHelper,
    // Services métier
    CourseOfferService,
    CourseActionService,
    CourseQueryService,
    CourseGroupingService, // Phase P3 : regroupement intelligent
    DeliveryActionService,
    DeliveryTrackingService, // Suivi temps réel côté client (position + statut livraison)
    OffreEnAttenteService, // Offre en attente du livreur (route + renvoi à la connexion)
    GardeOffresService, // Règle unique des offres : affectation forcée, relances, acceptation
    CourseEnLivraisonService, // Bouton caisse « Livreur a récupéré » : la course part en livraison
    AnnulationAutoService, // Annulation automatique sans jamais annuler une commande de client
    // Events + WS
    CourseEvent,
    CourseWebSocketService,
    // Listeners
    CourseListenerService,
    OrderBridgeListenerService,
    // Journal des offres, filet hors service, relance après clôture, offre renvoyée
    // à la connexion. Le journal et la clôture eux-mêmes : DispatchCommunModule (global).
    DispatchListener,
    RemiseCaisseListener, // Commande passée PICKED_UP hors code → course en livraison
    // Cron
    CourseTask,
    CourseBatchTask, // Phase P3 : flush des batches matures toutes les 10 s
  ],
  exports: [
    CourseOfferService,
    CourseActionService,
    CourseQueryService,
    CourseGroupingService,
  ],
})
export class CourseModule {}
