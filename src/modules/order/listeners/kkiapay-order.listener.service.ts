import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';
import { KkiapayWebhookDto } from 'src/kkiapay/kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { OrderEvent } from '../events/order.event';
import { OrderService } from '../services/order.service';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { RewardService } from 'src/modules/fidelity/services/reward.service';
import { ReferralService } from 'src/modules/referral/referral.service';
import { OrderStatus, LoyaltyPointType } from '@prisma/client';

@Injectable()
export class KkiapayOrderListenerService {
    logger = new Logger(KkiapayOrderListenerService.name);
    constructor(private readonly orderService: OrderService,
        private readonly paiementsService: PaiementsService,
        private orderEvent: OrderEvent,
        private readonly orderWebSocketService: OrderWebSocketService,
        private readonly expoPushService: ExpoPushService,
        private readonly notificationsSender: NotificationsSenderService,
        private readonly loyaltyService: LoyaltyService,
        private readonly rewardService: RewardService,
        private readonly referralService: ReferralService,
    ) { }

    @OnEvent(KkiapayChannels.TRANSACTION_SUCCESS)
    async orderStatutReady(payload: KkiapayWebhookDto) {
        const order = await this.orderService.findByReference(payload.stateData)
        if (!order) return;

        // Enregistre le paiement + claim atomique paied false→true. justPaid n'est vrai
        // que pour le PREMIER traitement réel du paiement (anti-rejeu webhook / double backend).
        const { paiement, justPaid } = await this.paiementsService.linkPaiementToOrder({
            transactionId: payload.transactionId,
            orderId: order.id,
            customer_id: order.customer_id
        });

        // Webhook rejoué / commande déjà payée → aucun effet de bord en double.
        if (!justPaid) return;

        // 🔔 CLOCHE staff resto — commande app payée EN LIGNE. linkPaiementToOrder a passé
        // le statut à ACCEPTED ; on le force ici car l'objet `order` (pré-update) est encore PENDING.
        void this.notificationsSender.sendOrderBell({ ...order, status: OrderStatus.ACCEPTED });

        const totalDishes = order.order_items.reduce(
            (sum, item) => sum + item.amount * item.quantity,
            0,
        );

        // ⭐ GAIN DE POINTS FIDÉLITÉ — SEUL point de gain des commandes app EN LIGNE :
        // paiement validé (justPaid) = commande ACCEPTED. addPoints émet l'event WS
        // `loyalty:points_added` → carte à gratter côté app. Idempotent par order_id,
        // non bloquant (on trace l'échec sans casser la confirmation de paiement).
        let earnedPoints = 0;
        try {
            if (order.net_amount > 0) {
                earnedPoints = await this.loyaltyService.calculatePointsForOrder(order.net_amount);
                if (earnedPoints > 0) {
                    await this.loyaltyService.addPoints({
                        customer_id: order.customer_id,
                        points: earnedPoints,
                        type: LoyaltyPointType.EARNED,
                        reason: `🎁 ${earnedPoints} points gagnés pour la commande #${order.reference}`,
                        order_id: order.id,
                    });
                    // 🎫 Récompense « à gratter » (couche célébration) — l'app l'affiche
                    // via GET /fidelity/rewards/pending puis la verrouille au grattage
                    // (POST /rewards/:id/scratch). Idempotent par order_id.
                    await this.rewardService.createPointsReward({
                        customer_id: order.customer_id,
                        points: earnedPoints,
                        order_id: order.id,
                        reason: `Commande #${order.reference}`,
                    });
                }
            }
        } catch (error) {
            this.logger.error(
                `Échec gain points (paiement) pour la commande ${order.reference}: ${error?.message}`,
                error?.stack,
            );
            earnedPoints = 0;
        }

        // 🤝 PARRAINAGE — si cette commande payée est la 1ère du filleul, on qualifie
        // le parrainage : le parrain reçoit sa carte à gratter. Idempotent (claim
        // atomique PENDING→REWARDED) et no-op si le client n'a pas de parrainage en
        // attente. Non bloquant.
        void this.referralService
            .qualifyReferralForPaidOrder(order.customer_id, order.id)
            .catch((error) =>
                this.logger.error(
                    `Échec qualification parrainage (commande ${order.reference}): ${error?.message}`,
                    error?.stack,
                ),
            );

        // 📲 Push « Commande confirmée » au CLIENT — envoyé MAINTENANT (paiement validé),
        // et non plus à la création PENDING. Mentionne les points gagnés : une notif
        // suffit si l'app est fermée et que la carte à gratter ne peut pas s'afficher.
        const expoToken = order.customer?.notification_settings?.expo_push_token;
        if (expoToken) {
            this.expoPushService.sendPushNotifications({
                tokens: [expoToken],
                title: "🍗 Commande confirmée !",
                body: `Merci pour votre confiance ❤️\nVotre paiement est validé. Votre commande ${order.reference} a bien été reçue.${earnedPoints > 0 ? `\n⭐ Vous avez gagné ${earnedPoints} points fidélité !` : ''}`,
                data: { order_id: order.id },
                subtitle: "On prépare ça avec amour 🔥",
                sound: "default",
                badge: 1,
                priority: 'high',
                ttl: 3600,
                channelId: "default",
                categoryId: "order-created",
            });
        }

        // Événement de création (notif staff + WebSocket) — une seule fois, au paiement.
        this.orderEvent.orderCreatedEvent({
            order: order,
            payment_id: paiement?.id,
            loyalty_level: order.customer.loyalty_level!,
            totalDishes: totalDishes,
            orderItems: order.order_items.map(item => ({ dish_id: item.dish_id, quantity: item.quantity, price: item.amount })),
        });

        this.orderWebSocketService.emitOrderCreated(order);
    }

}
