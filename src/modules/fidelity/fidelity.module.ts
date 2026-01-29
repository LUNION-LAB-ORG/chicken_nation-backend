import { Module } from '@nestjs/common';
import { PromotionService } from './services/promotion.service';
import { PromotionController } from './controllers/promotion.controller';
import { LoyaltyService } from './services/loyalty.service';
import { LoyaltyController } from './controllers/loyalty.controller';
import { PromotionListenerService } from './listeners/promotion-listener.service';
import { LoyaltyListenerService } from './listeners/loyalty-listener.service';
import { LoyaltyEvent } from './events/loyalty.event';
import { PromotionEvent } from './events/promotion.event';
import { LoyaltyTask } from './tasks/loyalty.task';
import { PromotionNotificationsTemplate } from './templates/promotion-notifications.template';
import { LoyaltyNotificationsTemplate } from './templates/loyalty-notifications.template';

@Module({
    controllers: [PromotionController, LoyaltyController],
    providers: [
        PromotionService,
        LoyaltyService,
        LoyaltyEvent,
        PromotionEvent,
        PromotionListenerService,
        LoyaltyListenerService,
        PromotionNotificationsTemplate,
        LoyaltyNotificationsTemplate,
        LoyaltyTask
    ],
    exports: [PromotionService, LoyaltyService, PromotionEvent, LoyaltyEvent],
})
export class FidelityModule { }