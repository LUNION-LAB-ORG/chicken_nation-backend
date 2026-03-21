import { Module } from '@nestjs/common';
import { PushCampaignService } from './push-campaign.service';
import { PushCampaignController } from './push-campaign.controller';
import { PushScheduledTask } from './tasks/push-scheduled.task';

@Module({
  controllers: [PushCampaignController],
  providers: [PushCampaignService, PushScheduledTask],
  exports: [PushCampaignService],
})
export class PushCampaignModule {}
