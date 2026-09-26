import { Module } from '@nestjs/common';
import { CrmAnalyticsController } from './controllers/crm-analytics.controller';
import { CrmCampaignController } from './controllers/crm-campaign.controller';
import { CrmConfigController } from './controllers/crm-config.controller';
import { CrmContactController } from './controllers/crm-contact.controller';
import { CrmListener } from './listeners/crm.listener';
import { CrmAccessService } from './services/crm-access.service';
import { CrmAlertService } from './services/crm-alert.service';
import { CrmAnalyticsService } from './services/crm-analytics.service';
import { CrmCallService } from './services/crm-call.service';
import { CrmCampaignStatsService } from './services/crm-campaign-stats.service';
import { CrmCampaignVentesService } from './services/crm-campaign-ventes.service';
import { CrmCampaignService } from './services/crm-campaign.service';
import { CrmConfigService } from './services/crm-config.service';
import { CrmCouponService } from './services/crm-coupon.service';
import { CrmEventsService } from './services/crm-events.service';
import { CrmExportService } from './services/crm-export.service';
import { CrmContactService } from './services/crm-contact.service';
import { CrmReportService } from './services/crm-report.service';
import { CrmCaptureService } from './services/crm-capture.service';
import { CrmPublicsService } from './services/crm-publics.service';
import { CrmIdentiteService } from './services/crm-identite.service';
import { CrmRattrapageService } from './services/crm-rattrapage.service';
import { CrmRegistreService } from './services/crm-registre.service';
import { CrmRepriseAcquisitionService } from './services/crm-reprise-acquisition.service';
import { CrmRepriseService } from './services/crm-reprise.service';
import { CrmSyncService } from './services/crm-sync.service';
import { CrmVentesService } from './services/crm-ventes.service';
import { CrmTask } from './tasks/crm.task';

/**
 * CRM : relance des inscrits qui n'ont jamais commandé et des anciens clients
 * devenus inactifs, avec la même file, les mêmes coupons et les mêmes
 * campagnes. Glovo/Yango y entreront au lot 2. (PrismaService, SettingsService, TwilioService, AppGateway et les
 * services de notification sont globaux.)
 */
@Module({
  controllers: [
    CrmContactController,
    CrmConfigController,
    CrmCampaignController,
    CrmAnalyticsController,
  ],
  providers: [
    CrmAccessService,
    CrmEventsService,
    CrmIdentiteService,
    CrmRegistreService,
    CrmSyncService,
    CrmCaptureService,
    CrmRattrapageService,
    CrmRepriseService,
    CrmRepriseAcquisitionService,
    CrmConfigService,
    CrmContactService,
    CrmCallService,
    CrmCouponService,
    CrmExportService,
    CrmCampaignStatsService,
    CrmCampaignVentesService,
    CrmCampaignService,
    CrmReportService,
    CrmAlertService,
    CrmPublicsService,
    CrmAnalyticsService,
    CrmVentesService,
    CrmListener,
    CrmTask,
  ],
  // Pour les routes de l'acquisition Glovo/Yango (capture, anciennes routes de l'appli caisse).
  exports: [CrmSyncService, CrmCaptureService, CrmAccessService, CrmCallService, CrmCouponService],
})
export class CrmModule {}
