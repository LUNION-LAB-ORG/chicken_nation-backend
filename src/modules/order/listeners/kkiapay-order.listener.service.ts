import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';
import { OrderService } from '../services/order.service';
import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { KkiapayWebhookDto } from 'src/kkiapay/kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';


@Injectable()
export class KkiapayOrderListenerService {
    logger = new Logger(KkiapayOrderListenerService.name);
    constructor(private readonly orderService: OrderService, private readonly prismaService: PrismaService, private readonly paiementsService: PaiementsService) { }

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
            if (paiement && paiement.status === 'SUCCESS') {
                await this.orderService.update(order.id, {
                    paied: true,
                    paied_at: new Date().toISOString(),
                })
            }
        }

    }

}
