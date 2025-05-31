import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { LoyaltyPointType, Order } from '@prisma/client';

@Injectable()
export class OrderListener {
  constructor(private loyaltyService: LoyaltyService) { }

  @OnEvent('order.created')
  async handleOrderCreated(payload: Order) {
    console.log("handleOrderCreated", payload);
  }

  @OnEvent('order.completed')
  async handleOrderCompleted(payload: {
    order_id: string;
    customer_id: string;
    net_amount: number;
    customer_name: string;
  }) {
    // Calculer et attribuer les points de fidélité
    const pointsToEarn = await this.loyaltyService.calculatePointsForOrder(payload.net_amount);

    if (pointsToEarn > 0) {
      await this.loyaltyService.addPoints({
        customer_id: payload.customer_id,
        points: pointsToEarn,
        type: LoyaltyPointType.EARNED,
        reason: `Points gagnés pour la commande`,
        order_id: payload.order_id
      });

      // TODO: Envoyer notification au client
      // await this.notificationService.sendPointsEarnedNotification(
      //   payload.customer_id,
      //   pointsToEarn,
      //   payload.customer_name
      // );
    }
  }

  @OnEvent('customer.levelUp')
  async handleCustomerLevelUp(payload: {
    customer_id: string;
    previous_level: string;
    new_level: string;
    customer_name: string;
  }) {
    // Attribuer des points bonus pour le nouveau niveau
    let bonusPoints = 0;
    switch (payload.new_level) {
      case 'PREMIUM':
        bonusPoints = 50;
        break;
      case 'GOLD':
        bonusPoints = 100;
        break;
    }

    if (bonusPoints > 0) {
      await this.loyaltyService.addPoints({
        customer_id: payload.customer_id,
        points: bonusPoints,
        type: LoyaltyPointType.BONUS,
        reason: `Bonus de bienvenue niveau ${payload.new_level}`
      });
    }

    // TODO: Envoyer notification de félicitations
    // await this.notificationService.sendLevelUpNotification(
    //   payload.customer_id,
    //   payload.new_level,
    //   bonusPoints,
    //   payload.customer_name
    // );
  }
}