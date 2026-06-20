import { Module } from '@nestjs/common';

// Controllers
import { StatisticsDashboardController } from './controllers/statistics-dashboard.controller';
import { StatisticsProductsController } from './controllers/statistics-products.controller';
import { StatisticsOrdersController } from './controllers/statistics-orders.controller';
import { StatisticsClientsController } from './controllers/statistics-clients.controller';
import { StatisticsDeliveryController } from './controllers/statistics-delivery.controller';
import { StatisticsMarketingController } from './controllers/statistics-marketing.controller';
import { StatisticsMarketingReportController } from './controllers/statistics-marketing-report.controller';

// Services
import { StatisticsService } from './services/statistics.service';
import { StatisticsProductsService } from './services/statistics-products.service';
import { StatisticsOrdersService } from './services/statistics-orders.service';
import { StatisticsClientsService } from './services/statistics-clients.service';
import { StatisticsDeliveryService } from './services/statistics-delivery.service';
import { StatisticsMarketingService } from './services/statistics-marketing.service';
import { MarketingReportService } from './services/marketing-report.service';

// Tasks
import { MarketingReportTask } from './tasks/marketing-report.task';
// ⚠️ StatisticsWarmupTask SUPPRIMÉ : il lançait 9 agrégations lourdes (40-77s,
// saturait les connexions Neon + bloquait l'event-loop) toutes les 4 min →
// incident prod. Le cache se remplit à la demande, c'est suffisant.
import { StatisticsMatviewTask } from './tasks/statistics-matview.task';

@Module({
  controllers: [
    // Dashboard synthétique (page d'accueil backoffice)
    StatisticsDashboardController,
    // Rapports détaillés par domaine
    StatisticsProductsController,
    StatisticsOrdersController,
    StatisticsClientsController,
    StatisticsDeliveryController,
    StatisticsMarketingController,
    StatisticsMarketingReportController,
  ],
  providers: [
    // Dashboard synthétique (conservé pour rétrocompatibilité)
    StatisticsService,
    // Services spécialisés par domaine
    StatisticsProductsService,
    StatisticsOrdersService,
    StatisticsClientsService,
    StatisticsDeliveryService,
    StatisticsMarketingService,
    MarketingReportService,
    // Tasks
    MarketingReportTask,
    StatisticsMatviewTask,
  ],
  exports: [
    StatisticsService,
    StatisticsProductsService,
    StatisticsOrdersService,
    StatisticsClientsService,
    StatisticsDeliveryService,
    StatisticsMarketingService,
    MarketingReportService,
  ],
})
export class StatisticsModule {}
