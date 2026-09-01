import { Module } from '@nestjs/common';
import { PushCampaignService } from './push-campaign.service';
import { PushCampaignController } from './push-campaign.controller';
import { PushScheduledTask } from './tasks/push-scheduled.task';
import { PushReceiptTask } from './tasks/push-receipt.task';

@Module({
  controllers: [PushCampaignController],
  providers: [PushCampaignService, PushScheduledTask, PushReceiptTask],
  exports: [PushCampaignService],
})
export class PushCampaignModule {}
