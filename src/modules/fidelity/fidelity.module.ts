import { Module } from '@nestjs/common';
import { PromotionService } from './services/promotion.service';
import { PromotionController } from './controllers/promotion.controller';
import { LoyaltyService } from './services/loyalty.service';
import { LoyaltyController } from './controllers/loyalty.controller';
import { RewardService } from './services/reward.service';
import { RewardController } from './controllers/reward.controller';
import { RewardCampaignService } from './services/reward-campaign.service';
import { RewardCampaignController } from './controllers/reward-campaign.controller';
import { RewardCampaignTask } from './tasks/reward-campaign.task';
import { PromotionListenerService } from './listeners/promotion-listener.service';
import { LoyaltyListenerService } from './listeners/loyalty-listener.service';
import { LoyaltyEvent } from './events/loyalty.event';
import { PromotionEvent } from './events/promotion.event';
import { LoyaltyTask } from './tasks/loyalty.task';
import { LoyaltyStatusResetTask } from './tasks/loyalty-status-reset.task';
import { PromotionNotificationsTemplate } from './templates/promotion-notifications.template';
import { LoyaltyNotificationsTemplate } from './templates/loyalty-notifications.template';
import { VoucherModule } from '../voucher/voucher.module';

@Module({
    imports: [VoucherModule],
    controllers: [PromotionController, LoyaltyController, RewardController, RewardCampaignController],
    providers: [
        PromotionService,
        LoyaltyService,
        RewardService,
        RewardCampaignService,
        LoyaltyEvent,
        PromotionEvent,
        PromotionListenerService,
        LoyaltyListenerService,
        PromotionNotificationsTemplate,
        LoyaltyNotificationsTemplate,
        LoyaltyTask,
        LoyaltyStatusResetTask,
        RewardCampaignTask
    ],
    exports: [PromotionService, LoyaltyService, RewardService, RewardCampaignService, PromotionEvent, LoyaltyEvent],
})
export class FidelityModule { }