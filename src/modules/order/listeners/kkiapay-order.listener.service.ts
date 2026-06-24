import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';
import { KkiapayWebhookDto } from 'src/kkiapay/kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { OrderEvent } from '../events/order.event';
import { OrderService } from '../services/order.service';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';

@Injectable()
export class KkiapayOrderListenerService {
    logger = new Logger(KkiapayOrderListenerService.name);
    constructor(private readonly orderService: OrderService,
        private readonly paiementsService: PaiementsService,
        private orderEvent: OrderEvent,
        private readonly orderWebSocketService: OrderWebSocketService,
        private readonly expoPushService: ExpoPushService,
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

        const totalDishes = order.order_items.reduce(
            (sum, item) => sum + item.amount * item.quantity,
            0,
        );

        // 📲 Push « Commande confirmée » au CLIENT — envoyé MAINTENANT (paiement validé),
        // et non plus à la création PENDING.
        const expoToken = order.customer?.notification_settings?.expo_push_token;
        if (expoToken) {
            this.expoPushService.sendPushNotifications({
                tokens: [expoToken],
                title: "🍗 Commande confirmée !",
                body: `Merci pour votre confiance ❤️\nVotre paiement est validé. Votre commande ${order.reference} a bien été reçue.`,
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
