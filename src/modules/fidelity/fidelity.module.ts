import { Module } from '@nestjs/common';
import { PromotionService } from './services/promotion.service';
import { PromotionController } from './controllers/promotion.controller';
import { LoyaltyService } from './services/loyalty.service';
import { LoyaltyController } from './controllers/loyalty.controller';
import { PromotionUsageService } from './services/promotion-usage.service';
import { PromotionListener } from './listeners/promotion.listener';
import { LoyaltyListener } from './listeners/loyalty.listener';
import { LoyaltyEvent } from './events/loyalty.event';
import { PromotionEvent } from './events/promotion.event';
@Module({
    controllers: [PromotionController, LoyaltyController],
    providers: [
        PromotionService,
        LoyaltyService,
        PromotionUsageService,
        LoyaltyEvent,
        PromotionEvent,
        PromotionListener,
        LoyaltyListener
    ],
    exports: [PromotionService, LoyaltyService, PromotionUsageService, PromotionEvent, LoyaltyEvent],
})
export class FidelityModule { }