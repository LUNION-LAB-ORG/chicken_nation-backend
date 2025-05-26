import { Module } from '@nestjs/common';
import { PromotionService } from './services/promotion.service';
import { PromotionController } from './controllers/promotion.controller';
import { LoyaltyService } from './services/loyalty.service';
import { LoyaltyController } from './controllers/loyalty.controller';

@Module({
    controllers: [PromotionController, LoyaltyController],
    providers: [PromotionService, LoyaltyService],
    exports: [PromotionService, LoyaltyService],
})
export class FidelityModule { }