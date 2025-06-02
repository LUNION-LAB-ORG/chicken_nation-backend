import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Order, OrderStatus } from '@prisma/client';

@Injectable()
export class NotificationsListener {
    constructor() { }

    @OnEvent('loyalty.redeemPoints')
    async handleRedeemPoints(payload: any) {

        // TODO: Envoyer notification au client points utilisés
        // await this.notificationService.sendPointsRedeemedNotification(
        //   payload.customer_id,
        //   payload.points,
        //   payload.customer_name
        // );
    }

    @OnEvent('loyalty.addPoints')
    async handleAddPoints(payload: any) {
        // TODO: Envoyer notification au client points gagnés
        // await this.notificationService.sendPointsEarnedNotification(
        //   payload.customer_id,
        //   payload.points,
        //   payload.customer_name
        // );
    }

    @OnEvent('loyalty.awardBonusPoints')
    async handleAwardBonusPoints(payload: any) {

        // TODO: Envoyer notification de félicitations au client points bonus niveau atteint
        // await this.notificationService.sendLevelUpNotification(
        //   payload.customer.id,
        //   payload.new_level,
        //   payload.bonus_points,
        //   payload.customer.name
        // );
    }

    @OnEvent('promotion.used')
    async handlePromotionUsed(payload: any) {

        // TODO: Envoyer notification de félicitations au client promotion utilisée
        // await this.notificationService.sendPromotionUsedNotification(
        //   payload.customer.id,
        //   payload.promotion_id,
        //   payload.customer.name
        // );
    }

    @OnEvent('paiement.effectue')
    async handlePaiementEffectue(payload: any) {
        // TODO: Envoyer notification au client paiement effectué
        // await this.notificationService.sendPaiementEffectueNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }

    @OnEvent('paiement.annule')
    async handlePaiementAnnule(payload: any) {
        // TODO: Envoyer notification au client paiement annulé
        // await this.notificationService.sendPaiementAnnuleNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }

    @OnEvent('order.created')
    async handleOrderCreated(payload: any) {
        // TODO: Envoyer notification au client commande créée
        // await this.notificationService.sendOrderCreatedNotification(
        //   payload.customer_id,
        //   payload.order.points,
        //   payload.customer_name
        // );
    }

    @OnEvent('order.statusUpdated')
    async handleOrderCompleted(payload: Order) {
        console.log("handleOrderCompleted", payload);

        // TODO: Envoyer notification au client commande terminée si order.status === COMPLETED
        if (payload.status === OrderStatus.COMPLETED) {
            // await this.notificationService.sendOrderCompletedNotification(
            //   payload.customer_id,
            //   payload.order.points,
            //   payload.customer_name
            // );
        }
    }
}