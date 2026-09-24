import { Module } from '@nestjs/common';
import { ConversionAnalyticsController } from './controllers/conversion-analytics.controller';
import { ConversionCampaignController } from './controllers/conversion-campaign.controller';
import { ConversionConfigController } from './controllers/conversion-config.controller';
import { ConversionProspectController } from './controllers/conversion-prospect.controller';
import { ConversionListener } from './listeners/conversion.listener';
import { ConversionAccessService } from './services/conversion-access.service';
import { ConversionAlertService } from './services/conversion-alert.service';
import { ConversionAnalyticsService } from './services/conversion-analytics.service';
import { ConversionCallService } from './services/conversion-call.service';
import { ConversionCampaignStatsService } from './services/conversion-campaign-stats.service';
import { ConversionCampaignService } from './services/conversion-campaign.service';
import { ConversionConfigService } from './services/conversion-config.service';
import { ConversionCouponService } from './services/conversion-coupon.service';
import { ConversionEventsService } from './services/conversion-events.service';
import { ConversionExportService } from './services/conversion-export.service';
import { ConversionProspectService } from './services/conversion-prospect.service';
import { ConversionReportService } from './services/conversion-report.service';
import { ConversionSyncService } from './services/conversion-sync.service';
import { ConversionTask } from './tasks/conversion.task';

/**
 * Module Prospects : conversion des inscrits qui n'ont jamais commandé.
 * (PrismaService, SettingsService, TwilioService, AppGateway et les
 * services de notification sont globaux.)
 */
@Module({
  controllers: [
    ConversionProspectController,
    ConversionConfigController,
    ConversionCampaignController,
    ConversionAnalyticsController,
  ],
  providers: [
    ConversionAccessService,
    ConversionEventsService,
    ConversionSyncService,
    ConversionConfigService,
    ConversionProspectService,
    ConversionCallService,
    ConversionCouponService,
    ConversionExportService,
    ConversionCampaignStatsService,
    ConversionCampaignService,
    ConversionReportService,
    ConversionAlertService,
    ConversionAnalyticsService,
    ConversionListener,
    ConversionTask,
  ],
  exports: [ConversionSyncService],
})
export class ConversionModule {}
