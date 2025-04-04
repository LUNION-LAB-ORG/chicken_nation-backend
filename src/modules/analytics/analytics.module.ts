import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserActivity } from './entities/user-activity.entity';
import { SalesStatistic } from './entities/sales-statistic.entity';
import { CustomReport } from './entities/custom-report.entity';
import { UserActivityService } from './services/user-activity.service';
import { SalesStatisticsService } from './services/sales-statistics.service';
import { CustomReportService } from './services/custom-report.service';
import { UserActivityController } from './controllers/user-activity.controller';
import { SalesStatisticsController } from './controllers/sales-statistics.controller';
import { CustomReportController } from './controllers/custom-report.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserActivity, SalesStatistic, CustomReport]),
  ],
  controllers: [
    UserActivityController,
    SalesStatisticsController,
    CustomReportController,
  ],
  providers: [
    UserActivityService,
    SalesStatisticsService,
    CustomReportService,
  ],
  exports: [
    UserActivityService,
    SalesStatisticsService,
    CustomReportService,
  ],
})
export class AnalyticsModule {}
