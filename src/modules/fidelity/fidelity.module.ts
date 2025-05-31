import { Module } from '@nestjs/common';
import { PromotionService } from './services/promotion.service';
import { PromotionController } from './controllers/promotion.controller';
import { LoyaltyService } from './services/loyalty.service';
import { LoyaltyController } from './controllers/loyalty.controller';
import { PromotionUsageService } from './services/promotion-usage.service';

@Module({
    controllers: [PromotionController, LoyaltyController],
    providers: [PromotionService, LoyaltyService, PromotionUsageService],
    exports: [PromotionService, LoyaltyService, PromotionUsageService],
})
export class FidelityModule { }