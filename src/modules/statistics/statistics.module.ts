import { Module } from '@nestjs/common';

// Controllers
import { StatisticsDashboardController } from './controllers/statistics-dashboard.controller';
import { StatisticsProductsController } from './controllers/statistics-products.controller';
import { StatisticsOrdersController } from './controllers/statistics-orders.controller';
import { StatisticsClientsController } from './controllers/statistics-clients.controller';
import { StatisticsDeliveryController } from './controllers/statistics-delivery.controller';
import { StatisticsMarketingController } from './controllers/statistics-marketing.controller';

// Services
import { StatisticsService } from './services/statistics.service';
import { StatisticsProductsService } from './services/statistics-products.service';
import { StatisticsOrdersService } from './services/statistics-orders.service';
import { StatisticsClientsService } from './services/statistics-clients.service';
import { StatisticsDeliveryService } from './services/statistics-delivery.service';
import { StatisticsMarketingService } from './services/statistics-marketing.service';

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
  ],
  exports: [
    StatisticsService,
    StatisticsProductsService,
    StatisticsOrdersService,
    StatisticsClientsService,
    StatisticsDeliveryService,
    StatisticsMarketingService,
  ],
})
export class StatisticsModule {}
