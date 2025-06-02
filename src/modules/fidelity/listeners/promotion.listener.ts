import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { PromotionUsageService } from 'src/modules/fidelity/services/promotion-usage.service';
import { PromotionEvent } from 'src/modules/fidelity/events/promotion.event';

@Injectable()
export class PromotionListener {
    constructor(private promotionUsageService: PromotionUsageService, private promotionEvent: PromotionEvent) { }

    @OnEvent('order.created')
    async handleOrderCreated(payload: OrderCreatedEvent) {
        if (payload.order.promotion_id) {
            await this.promotionUsageService.usePromotion(payload.order.promotion_id, payload.order.customer_id, payload.order.id, payload.totalDishes, payload.orderItems, payload.loyalty_level);
            console.log('Promotion used');

            // Evenement de promotion utilisée
            this.promotionEvent.promotionUsed({});
        }
    }
}