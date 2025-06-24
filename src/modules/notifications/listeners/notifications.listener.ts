import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsSenderService } from '../services/notifications-sender.service';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { Category, Customer, Dish, Order, Promotion } from '@prisma/client';

@Injectable()
export class NotificationsListener {
    constructor(private notificationSenderService: NotificationsSenderService) { }

    // COMMANDE
    // @OnEvent('order.created')
    // async handleOrderCreated(payload: OrderCreatedEvent) {
    //     await this.notificationSenderService.handleOrderCreated(payload);
    // }

    @OnEvent('order.statusUpdated')
    async handleOrderStatusUpdated(order: Order) {
        await this.notificationSenderService.handleOrderStatusUpdate(order);
    }

    // PAIEMENT
    @OnEvent('paiement.annule')
    async handlePaiementAnnule(payload: any) {
        // TODO: Envoyer notification au client paiement annulé
        // await this.notificationSenderService.sendPaiementAnnuleNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }

    @OnEvent('payment.completed')
    async handlePaymentCompleted(payload: { payment: any; order: any; customer: any }) {
        await this.notificationSenderService.handlePaymentCompleted(
            payload.payment,
            payload.order,
            payload.customer
        );
    }
    @OnEvent('paiement.effectue')
    async handlePaiementEffectue(payload: any) {
        // TODO: Envoyer notification au client paiement effectué
        // await this.notificationSenderService.sendPaiementEffectueNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }

    // POINT DE FIDELITE
    @OnEvent('loyalty.pointsEarned')
    async handlePointsEarned(payload: { customer: any; points: number; totalPoints: number; reason?: string }) {
        // await this.notificationSenderService.handleLoyaltyPointsEarned(
        //     payload.customer,
        //     payload.points,
        //     payload.totalPoints,
        //     payload.reason
        // );
    }

    @OnEvent('loyalty.levelUp')
    async handleLevelUp(payload: { customer: any; newLevel: string; bonusPoints: number }) {
        await this.notificationSenderService.handleLoyaltyLevelUp(
            payload.customer,
            payload.newLevel,
            payload.bonusPoints
        );
    }

    @OnEvent('loyalty.redeemPoints')
    async handleRedeemPoints(payload: any) {

        // TODO: Envoyer notification au client points utilisés
        // await this.notificationSenderService.sendPointsRedeemedNotification(
        //   payload.customer_id,
        //   payload.points,
        //   payload.customer_name
        // );
    }

    @OnEvent('loyalty.addPoints')
    async handleAddPoints(payload: any) {
        // TODO: Envoyer notification au client points gagnés
        // await this.notificationSenderService.sendPointsEarnedNotification(
        //   payload.customer_id,
        //   payload.points,
        //   payload.customer_name
        // );
    }

    @OnEvent('loyalty.awardBonusPoints')
    async handleAwardBonusPoints(payload: any) {

        // TODO: Envoyer notification de félicitations au client points bonus niveau atteint
        // await this.notificationSenderService.sendLevelUpNotification(
        //   payload.customer.id,
        //   payload.new_level,
        //   payload.bonus_points,
        //   payload.customer.name
        // );
    }

    // PROMOTION
    @OnEvent('promotion.used')
    async handlePromotionUsed(payload: { customer: Customer; promotion: Promotion; discountAmount: number }) {
        await this.notificationSenderService.handlePromotionUsed(
            payload.customer,
            payload.promotion,
            payload.discountAmount
        );
    }

    // CATEGORIE
    @OnEvent('category.created')
    async handleCategoryCreated(payload: Category) {
        await this.notificationSenderService.handleCategoryCreatedOrUpdate(payload);
    }

    @OnEvent('category.updated')
    async handleCategoryUpdated(payload: Category) {
        await this.notificationSenderService.handleCategoryCreatedOrUpdate(payload, true);
    }

    // PLAT
    @OnEvent('dish.created')
    async handleDishCreated(payload: Dish) {
        await this.notificationSenderService.handleDishCreatedOrUpdate(payload);
    }

    @OnEvent('dish.updated')
    async handleDishUpdated(payload: Dish) {
        await this.notificationSenderService.handleDishCreatedOrUpdate(payload, true);
    }

}