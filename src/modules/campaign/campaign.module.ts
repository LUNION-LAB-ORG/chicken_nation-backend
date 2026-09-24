import { Module } from '@nestjs/common';
import { CampaignController } from './controllers/campaign.controller';
import { CampaignProspectController } from './controllers/campaign-prospect.controller';
import { CampaignService } from './services/campaign.service';

@Module({
  controllers: [CampaignController, CampaignProspectController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
// Add the controller to the module manually using another script
