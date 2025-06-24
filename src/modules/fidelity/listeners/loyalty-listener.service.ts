import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { LoyaltyPointType, Order, OrderStatus } from '@prisma/client';
import { LoyaltyLevelUpEvent } from '../interfaces/loyalty-event.interface';
import { LoyaltyEvent } from '../events/loyalty.event';

@Injectable()
export class LoyaltyListenerService {
    constructor(private loyaltyService: LoyaltyService, private loyaltyEvent: LoyaltyEvent) { }

    @OnEvent('order.created')
    async handleOrderCreated(payload: OrderCreatedEvent) {
        if (payload.order.points !== 0) {
            //Utilisation des points
            await this.loyaltyService.redeemPoints({ customer_id: payload.order.customer_id, points: payload.order.points, reason: `Utilisation de ${payload.order.points} points de fidélité pour votre commande` });
            console.log(`Points redeemed ${payload.order.points}`);

            // Evenement de rachat de points
            this.loyaltyEvent.redeemPoints(payload);
        }
    }

    @OnEvent('order.statusUpdated')
    async handleOrderStatusUpdated(order: Order) {
        //Attribuer des points de fidélité si client identifié
        const pts = await this.loyaltyService.calculatePointsForOrder(order.net_amount);
        if (pts > 0 && order.status === OrderStatus.COMPLETED) {
            await this.loyaltyService.addPoints({
                customer_id: order.customer_id,
                points: pts,
                type: LoyaltyPointType.EARNED,
                reason: `Vous avez gagné ${pts} points de fidélité pour votre commande`,
                order_id: order.id
            })
            console.log(`Points added ${pts}`);

            // Evenement d'ajout de points
            this.loyaltyEvent.addPoints({});
        }
    }

    @OnEvent('loyalty.levelUp')
    async handleLoyaltyLevelUp(payload: LoyaltyLevelUpEvent) {
        // Attribuer des points bonus pour le nouveau niveau
        let bonusPoints = 0;
        switch (payload.new_level) {
            case 'STANDARD':
                bonusPoints = 100;
                break;
            case 'PREMIUM':
                bonusPoints = 150;
                break;
            case 'GOLD':
                bonusPoints = 200;
                break;
        }

        if (bonusPoints > 0) {
            await this.loyaltyService.addPoints({
                customer_id: payload.customer.id,
                points: bonusPoints,
                type: LoyaltyPointType.BONUS,
                reason: `Bonus de bienvenue niveau ${payload.new_level}`
            });
            console.log(`Points bonus added ${bonusPoints}`);

            // Evenement d'ajout de points bonus
            // this.loyaltyEvent.awardBonusPoints({});
        }
    }
}