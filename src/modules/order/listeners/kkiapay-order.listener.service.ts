import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';
import { OrderService } from '../services/order.service';
import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { KkiapayWebhookDto } from 'src/kkiapay/kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { OrderEvent } from '../events/order.event';


@Injectable()
export class KkiapayOrderListenerService {
    logger = new Logger(KkiapayOrderListenerService.name);
    constructor(private readonly orderService: OrderService,
        private readonly prismaService: PrismaService,
        private readonly paiementsService: PaiementsService,
        private orderEvent: OrderEvent,
        private readonly orderWebSocketService: OrderWebSocketService
    ) { }

    @OnEvent(KkiapayChannels.TRANSACTION_SUCCESS)
    async orderStatutReady(payload: KkiapayWebhookDto) {
        this.logger.log("==========================================================================\nJe récupérer les informations du paiement par webhook de kkipay\n==========================================================================")
        this.logger.log({ payload })
        this.logger.log("========================================================================== recherche de la commande")
        const order = await this.orderService.findByReference(payload.stateData)
        this.logger.log("========================================================================== commande trouvée")
        this.logger.log({ order })
        this.logger.log("========================================================================== mise à jour du statut de la commande")
        if (order) {
            // Enregistrer le paiement
            const paiement = await this.paiementsService.linkPaiementToOrder({
                transactionId: payload.transactionId,
                orderId: order.id,
                customer_id: order.customer_id
            });
            const totalDishes = order.order_items.reduce(
                (sum, item) => sum + item.amount * item.quantity,
                0,
            );
            if (paiement) {
                // Envoyer l'événement de création de commande
                this.orderEvent.orderCreatedEvent({
                    order: order,
                    payment_id: paiement?.id,
                    loyalty_level: order.customer.loyalty_level!,
                    totalDishes: totalDishes,
                    orderItems: order.order_items.map(item => ({ dish_id: item.dish_id, quantity: item.quantity, price: item.amount })),
                });

                // Émettre l'événement de création de commande
                this.orderWebSocketService.emitOrderCreated(order);
            }
        }

    }

}
