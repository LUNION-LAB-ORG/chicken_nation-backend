import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EntityStatus, LoyaltyPointType, OrderStatus, OrderType, PaymentMethod } from '@prisma/client';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { PromotionService } from 'src/modules/fidelity/services/promotion.service';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { UserPushService } from 'src/modules/users/services/user-push.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';

@Injectable()
export class OrderListenerService {
    private readonly logger = new Logger(OrderListenerService.name);

    constructor(
        private promotionService: PromotionService,
        private loyaltyService: LoyaltyService,
        private expoPushService: ExpoPushService,
        private userPushService: UserPushService,
        private notificationsSender: NotificationsSenderService,
    ) { }

    /* =========================================================
        🛍️ COMMANDE CRÉÉE
    ========================================================= */
    @OnEvent(OrderChannels.ORDER_CREATED)
    async orderCreatedEventListener(payload: OrderCreatedEvent) {
        // 🔔 Push notif aux staffs du restaurant — fire-and-forget,
        // ne JAMAIS bloquer la mutation principale. La socket reste la source
        // primaire de l'update temps réel ; le push est l'alerte "app fermée".
        if (payload.order.restaurant_id) {
            void this.userPushService.notifyRestaurant({
                restaurantId: payload.order.restaurant_id,
                type: 'new_order',
                title: '🔔 Nouvelle commande',
                body: `Cmde ${payload.order.reference} · ${Number(payload.order.amount ?? 0).toLocaleString('fr-FR')} F`,
                critical: true,
                data: { orderId: payload.order.id, reference: payload.order.reference },
            });
        }

        // 🔔 CLOCHE staff resto — commandes ACTIONNABLES uniquement (status != PENDING) :
        // commandes staff/cash dès la création (ACCEPTED). Les commandes app EN LIGNE sont
        // notifiées au PAIEMENT (cf. KkiapayOrderListenerService) pour ne pas alerter sur un
        // brouillon non payé.
        if (payload.order.status !== OrderStatus.PENDING) {
            void this.notificationsSender.sendOrderBell(payload.order);
        }

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

        // ⭐ UTILISATION DES POINTS — commande créée déjà ACCEPTÉE (ex: commande staff).
        // Idempotent + lié à la commande via order_id ; tracé en cas d'échec.
        if (payload.order.points > 0 && payload.order.status === OrderStatus.ACCEPTED) {
            try {
                await this.loyaltyService.redeemPoints({
                    customer_id: payload.order.customer_id,
                    points: payload.order.points,
                    order_id: payload.order.id,
                    reason: `🔥 ${payload.order.points} points utilisés pour la commande #${payload.order.reference}`,
                });
                isLoyaltyUsed = true;
            } catch (error) {
                this.logger.error(
                    `Échec de la déduction des points fidélité (création) pour la commande ${payload.order.reference}: ${error?.message}`,
                    error?.stack,
                );
            }
        }

        // 📲 NOTIFICATION CLIENT
        // Pour une commande app payée EN LIGNE (auto + ONLINE), on NE notifie PAS à la
        // création (PENDING/non payée) : le push « Commande confirmée » part au succès du
        // paiement (cf. KkiapayOrderListenerService). Les commandes cash/app (OFFLINE) et
        // staff conservent le comportement actuel (push à la création).
        const isUnpaidOnlineAppOrder =
            payload.order.auto === true &&
            payload.order.payment_method === PaymentMethod.ONLINE &&
            payload.order.paied !== true;
        if (payload.expo_token && !isUnpaidOnlineAppOrder) {
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
           ✅ COMMANDE ACCEPTÉE → déduire les points et appliquer les promotions
        ========================= */
        if (payload.order.status === OrderStatus.ACCEPTED) {
            // ⭐ DÉDUCTION DES POINTS DE FIDÉLITÉ — commande client confirmée.
            // C'est ICI que se joue la déduction des commandes client (créées PENDING
            // puis acceptées). redeemPoints est idempotent par order_id : pas de double
            // déduction si ACCEPTED est ré-émis. Non bloquant, mais on TRACE l'échec
            // (avant : silencieux → la déduction échouait sans laisser de trace).
            if (payload.order.points > 0) {
                try {
                    await this.loyaltyService.redeemPoints({
                        customer_id: payload.order.customer_id,
                        points: payload.order.points,
                        order_id: payload.order.id,
                        reason: `🔥 ${payload.order.points} points utilisés pour la commande #${payload.order.reference}`,
                    });
                } catch (error) {
                    this.logger.error(
                        `Échec de la déduction des points fidélité (acceptation) pour la commande ${payload.order.reference}: ${error?.message}`,
                        error?.stack,
                    );
                }
            }

            // 🔔 CLOCHE staff resto — la commande vient d'être ACCEPTÉE (client confirmé).
            void this.notificationsSender.sendOrderBell(payload.order);
        }

        /* =========================
           🍽️ COMMANDE PRÊTE → notifier le staff resto
        ========================= */
        if (payload.order.status === OrderStatus.READY) {
            void this.notificationsSender.sendOrderBell(payload.order);
        }

        /* =========================
           ✅ COMMANDE TERMINÉE
        ========================= */
        if (payload.order.status === OrderStatus.COMPLETED) {
            // 🔔 CLOCHE staff — commande terminée (état important).
            void this.notificationsSender.sendOrderBell(payload.order);

            // ⭐ DÉDUCTION DES POINTS — FILET DE SÉCURITÉ À LA CLÔTURE.
            // Beaucoup de commandes (« À livrer » / Turbo « workflow manuel ») atteignent
            // TERMINÉE SANS jamais passer par ACCEPTED : le validateur autorise de sauter
            // directement vers COMPLETED (order.helper validateStatusTransition). La déduction
            // câblée sur ACCEPTED ne s'exécutait donc jamais pour elles, alors que le GAIN
            // ci-dessous, lui, tourne → le solde ne faisait qu'augmenter.
            // On déduit donc AUSSI ici. redeemPoints est idempotent par order_id : si ACCEPTED
            // a déjà déduit, c'est un no-op (aucune double déduction).
            if (payload.order.points > 0) {
                try {
                    await this.loyaltyService.redeemPoints({
                        customer_id: payload.order.customer_id,
                        points: payload.order.points,
                        order_id: payload.order.id,
                        reason: `🔥 ${payload.order.points} points utilisés pour la commande #${payload.order.reference}`,
                    });
                } catch (error) {
                    this.logger.error(
                        `Échec de la déduction des points fidélité (clôture) pour la commande ${payload.order.reference}: ${error?.message}`,
                        error?.stack,
                    );
                }
            }

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
        if (payload.order.status === OrderStatus.CANCELLED) {
            // 🔔 CLOCHE staff — annulation (état important), même sans expo_token client.
            void this.notificationsSender.sendOrderBell(payload.order);
        }

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
