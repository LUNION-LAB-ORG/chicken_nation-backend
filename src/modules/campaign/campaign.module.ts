import { Module } from '@nestjs/common';
import { ProspectModule } from 'src/modules/prospect/prospect.module';
import { CampaignController } from './controllers/campaign.controller';
import { CampaignProspectController } from './controllers/campaign-prospect.controller';
import { CampaignService } from './services/campaign.service';

@Module({
  imports: [ProspectModule],
  controllers: [CampaignController, CampaignProspectController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
