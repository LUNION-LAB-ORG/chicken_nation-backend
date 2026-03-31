import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EntityStatus, LoyaltyPointType, OrderStatus, OrderType } from '@prisma/client';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { PromotionService } from 'src/modules/fidelity/services/promotion.service';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { ExpoPushService } from 'src/expo-push/expo-push.service';

@Injectable()
export class OrderListenerService {
    constructor(
        private promotionService: PromotionService,
        private loyaltyService: LoyaltyService,
        private expoPushService: ExpoPushService
    ) { }

    /* =========================================================
        🛍️ COMMANDE CRÉÉE
    ========================================================= */
    @OnEvent(OrderChannels.ORDER_CREATED)
    async orderCreatedEventListener(payload: OrderCreatedEvent) {
        let isPromotionUsed = false;
        let isLoyaltyUsed = false;

        // 🔥 PROMOTION
        if (payload.order.promotion_id) {
            if (
                payload.order.status === OrderStatus.ACCEPTED &&
                payload.totalDishes &&
                payload.orderItems
            ) {
                const promotion = await this.promotionService.usePromotion(
                    payload.order.promotion_id,
                    payload.order.customer_id,
                    payload.order.id,
                    payload.totalDishes,
                    payload.orderItems,
                    payload.loyalty_level
                );

                isPromotionUsed =
                    promotion.final_amount < payload.order.amount;
            }
        }

        // ⭐ UTILISATION DES POINTS
        if (payload.order.points > 0) {
            if (payload.order.status === OrderStatus.ACCEPTED) {
                await this.loyaltyService.redeemPoints({
                    customer_id: payload.order.customer_id,
                    points: payload.order.points,
                    reason: `🔥 ${payload.order.points} points utilisés pour la commande #${payload.order.reference}`,
                });
                isLoyaltyUsed = true;
            }
        }

        // 📲 NOTIFICATION
        if (payload.expo_token) {
            const promotionMessage = isPromotionUsed
                ? "🎉 Une promotion a été appliquée à votre commande !"
                : "";

            const loyaltyMessage = isLoyaltyUsed
                ? `⭐ Vous avez utilisé ${payload.order.points} points fidélité.`
                : "";

            this.expoPushService.sendPushNotifications({
                tokens: [payload.expo_token],
                title: "🍗 Commande confirmée !",
                body: `Merci pour votre confiance ❤️\nVotre commande ${payload.order.reference} a bien été reçue.\n${promotionMessage} ${loyaltyMessage}`,
                data: { order_id: payload.order.id },
                subtitle: "On prépare ça avec amour 🔥",
                sound: "default",
                badge: 1,
                priority: 'high',
                ttl: 3600,
                channelId: "default",
                categoryId: "order-created",
            });
        }
    }

    /* =========================================================
        🚀 STATUT MIS À JOUR
    ========================================================= */
    @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
    async orderStatusUpdatedEventListener(payload: OrderCreatedEvent) {

        /* =========================
           ✅ COMMANDE TERMINÉE
        ========================= */
        if (payload.order.status === OrderStatus.COMPLETED) {
            const pts = await this.loyaltyService.calculatePointsForOrder(
                payload.order.net_amount
            );

            const isPointsEarned = pts > 0;

            if (isPointsEarned) {
                await this.loyaltyService.addPoints({
                    customer_id: payload.order.customer_id,
                    points: pts,
                    type: LoyaltyPointType.EARNED,
                    reason: `🎉 ${pts} points gagnés grâce à votre commande`,
                    order_id: payload.order.id,
                });
            }

            if (payload.expo_token) {
                this.expoPushService.sendPushNotifications({
                    tokens: [payload.expo_token],
                    title: "🎉 Merci pour votre commande !",
                    body: `Votre expérience compte pour nous ❤️ ${isPointsEarned
                        ? `Bonne nouvelle : vous avez gagné ${pts} points fidélité ⭐`
                        : ""
                        }`,
                    data: { order_id: payload.order.id },
                    subtitle: "À très vite chez Chick Nation 🍗",
                    sound: "default",
                    badge: 1,
                    priority: 'high',
                    ttl: 3600,
                    channelId: "default",
                    categoryId: "order-completed",
                });
            }
        }

        /* =========================
           ❌ COMMANDE ANNULÉE
        ========================= */
        if (
            payload.order.status === OrderStatus.CANCELLED &&
            payload.expo_token
        ) {
            let body = "Votre commande a été annulée. Nous espérons vous revoir très bientôt pour une nouvelle expérience savoureuse 🍗";
            let subtitle = "On reste à votre service ❤️";

            if (payload.voucher) {
                body = `Votre commande a été annulée. Un bon d'achat de ${payload.voucher.initial_amount} FCFA (code: ${payload.voucher.code}) a été crédité sur votre compte 🎁`;
                subtitle = "Utilisez-le lors de votre prochaine commande ❤️";
            }

            this.expoPushService.sendPushNotifications({
                tokens: [payload.expo_token],
                title: "😔 Commande annulée",
                body,
                data: {
                    order_id: payload.order.id,
                    ...(payload.voucher && { voucher_code: payload.voucher.code }),
                },
                subtitle,
                sound: "default",
                badge: 1,
                priority: 'high',
                ttl: 3600,
                channelId: "default",
                categoryId: "order-cancelled",
            });
        }

        /* =========================
           🍽️ COMMANDE PRÊTE
        ========================= */
        if (payload.order.status === OrderStatus.READY && payload.expo_token) {
            if (payload.order.type === OrderType.DELIVERY) {
                this.expoPushService.sendPushNotifications({
                    tokens: [payload.expo_token],
                    title: "🔥 Votre plat est prêt !",
                    body: "Votre commande est prête et sera bientôt en livraison 🚚",
                    data: { order_id: payload.order.id },
                    subtitle: "Merci pour votre confiance 🍗",
                    sound: "default",
                    badge: 1,
                    priority: 'high',
                    ttl: 3600,
                    channelId: "default",
                    categoryId: "order-ready",
                });
            } else {
                this.expoPushService.sendPushNotifications({
                    tokens: [payload.expo_token],
                    title: "🔥 C’est prêt !",
                    body: "Votre commande est prête ! Elle n’attend plus que vous 😋",
                    data: { order_id: payload.order.id },
                    subtitle: "On vous attend chez Chick Nation 🍗",
                    sound: "default",
                    badge: 1,
                    priority: 'high',
                    ttl: 3600,
                    channelId: "default",
                    categoryId: "order-ready",
                });
            }

        }

        /* =========================
           🚚 EN LIVRAISON
        ========================= */
        if (
            payload.order.status === OrderStatus.PICKED_UP &&
            payload.expo_token
        ) {
            this.expoPushService.sendPushNotifications({
                tokens: [payload.expo_token],
                title: "🚚 En route vers vous !",
                body: "Votre commande est en cours de livraison. Préparez-vous à vous régaler 😍",
                data: { order_id: payload.order.id },
                // subtitle: "",
                sound: "default",
                badge: 1,
                priority: 'high',
                ttl: 3600,
                channelId: "default",
                categoryId: "order-picked-up",
            });
        }

        /* =========================
           📦 COMMANDE SUPPRIMÉE
        ========================= */
        if (payload.order.entity_status === EntityStatus.DELETED && payload.expo_token) {
            this.expoPushService.sendPushNotifications({
                tokens: [payload.expo_token],
                title: "Commande supprimée",
                body: "Votre commande a été supprimée. Nous espérons vous revoir très bientôt pour une nouvelle expérience savoureuse 🍗",
                data: { order_id: payload.order.id },
                subtitle: "On reste à votre service",
                sound: "default",
                badge: 1,
                priority: 'high',
                ttl: 3600,
                channelId: "default",
                categoryId: "order-deleted",
            });
        }
    }

    /* =========================================================
        🔄 AUTRES ÉVÉNEMENTS
    ========================================================= */
    @OnEvent(OrderChannels.ORDER_UPDATED)
    async orderUpdatedEventListener(payload: OrderCreatedEvent) {
        // Possibilité future : notifier en cas de modification importante
    }

    @OnEvent(OrderChannels.ORDER_DELETED)
    async orderDeletedEventListener(payload: OrderCreatedEvent) {
        // TODO
    }
}
