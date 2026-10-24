import { Module } from '@nestjs/common';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';
import { MapsModule } from 'src/modules/maps/maps.module';
import { TurboModule } from 'src/turbo/turbo.module';

import { CourseAdminController } from './controllers/course-admin.controller';
import { CourseDelivererController } from './controllers/course-deliverer.controller';
import { CourseOperationsController } from './controllers/course-operations.controller';
import { LivraisonTableauController } from './controllers/livraison-tableau.controller';
import { CourseEvent } from './events/course.event';
import { CourseHelper } from './helpers/course.helper';
import { CourseSettingsHelper } from './helpers/course-settings.helper';
import { CourseListenerService } from './listeners/course.listener.service';
import { DispatchListener } from './listeners/dispatch.listener';
import { OrderBridgeListenerService } from './listeners/order-bridge.listener.service';
import { PlanificateurListener } from './listeners/planificateur.listener';
import { RemiseCaisseListener } from './listeners/remise-caisse.listener';
import { RetenueALArriveeListener } from './listeners/retenue-a-l-arrivee.listener';
import { SuiviOffresListener } from './listeners/suivi-offres.listener';
import { AnnulationAutoService } from './services/annulation-auto.service';
import { CourseActionService } from './services/course-action.service';
import { CourseEnLivraisonService } from './services/course-en-livraison.service';
import { CourseGroupingService } from './services/course-grouping.service';
import { ApplicationPlanService } from './services/application-plan.service';
import { CourseOfferService } from './services/course-offer.service';
import { CoursePlanificateurService } from './services/course-planificateur.service';
import { CourseQueryService } from './services/course-query.service';
import { DeliveryActionService } from './services/delivery-action.service';
import { DeliveryTrackingService } from './services/delivery-tracking.service';
import { ArriveeAutoService } from './services/arrivee-auto.service';
import { LivraisonVersLivreurListener } from './listeners/livraison-vers-livreur.listener';
import { DepartCourseService } from './services/depart-course.service';
import { DirectionService } from './services/direction.service';
import { EstimationPreparationService } from './services/estimation-preparation.service';
import { GardeOffresService } from './services/garde-offres.service';
import { InstantanePlanificationService } from './services/instantane-planification.service';
import { LotsV2Service } from './services/lots-v2.service';
import { OffreEnAttenteService } from './services/offre-en-attente.service';
import { TableauLivraisonService } from './services/tableau-livraison.service';
import { CourseBatchTask } from './tasks/course-batch.task';
import { CoursePlanificateurTask } from './tasks/course-planificateur.task';
import { CourseTask } from './tasks/course.task';
import { PurgeJournalDispatchTask } from './tasks/purge-journal-dispatch.task';
import { CourseWebSocketService } from './websockets/course-websocket.service';

@Module({
  // TurboModule : bascule vers la flotte externe quand la flotte interne est saturée.
  // MapsModule : ETA client (trafic + arrêts) dans le suivi de livraison.
  imports: [AuthDelivererModule, DeliverersModule, TurboModule, MapsModule],
  controllers: [
    CourseDelivererController,
    CourseAdminController,
    CourseOperationsController,
    LivraisonTableauController, // `GET /livraison/tableau` : bandeau, alertes, ligne Livreurs
  ],
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
    DirectionService, // « Même direction » : tracés et détours Google pour la règle de regroupement
    // Planificateur v2 (regroupement par direction, retenue au comptoir, fusions, offres par urgence)
    EstimationPreparationService, // Fin de préparation estimée (cuisine, statistique horaire, défauts)
    InstantanePlanificationService, // Lecture de l'instantané d'un restaurant
    ApplicationPlanService, // Application conditionnelle et journalisée des actions
    CoursePlanificateurService, // Passages sous verrou par restaurant, regroupés (500 ms)
    LotsV2Service, // Lots sous v2 : vidés pour la flotte interne, direction pour Turbo
    DepartCourseService, // Départ du restaurant, « Je pars », retrait complémentaire
    ArriveeAutoService, // Arrivées au restaurant et chez le client déduites des positions
    TableauLivraisonService, // Tableau de la livraison : chiffres par restaurant, alertes (gardé 10 s)
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
    PlanificateurListener, // Événements qui demandent un passage du planificateur v2
    LivraisonVersLivreurListener, // Livraison changée : `course:statut:changed` au livreur
    RetenueALArriveeListener, // Retenue d'une course acceptée annoncée à l'arrivée au comptoir
    SuiviOffresListener, // Offre proposée, refusée, expirée, close : écran Opérations et caisse à jour
    // Cron
    CourseTask,
    CourseBatchTask, // Phase P3 : flush des batches matures toutes les 10 s
    CoursePlanificateurTask, // Planificateur v2 : passage de 10 s, statistique de préparation horaire
    PurgeJournalDispatchTask, // Journal de la diffusion conservé 90 jours
  ],
  exports: [
    CourseOfferService,
    CourseActionService,
    CourseQueryService,
    CourseGroupingService,
    DirectionService,
  ],
})
export class CourseModule {}
