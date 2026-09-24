import { Module } from '@nestjs/common';
import { CampaignController } from './controllers/campaign.controller';
import { CampaignService } from './services/campaign.service';

@Module({
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
