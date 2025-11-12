import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { TurboService } from 'src/turbo/services/turbo.service';
import { OrderStatus, DeliveryService } from '@prisma/client';
import { KkiapayChannels } from 'src/kkiapay/kkiapay-channels';


@Injectable()
export class KkiapayOrderListenerService {

    constructor(private readonly kkiapayService: TurboService) { }

    @OnEvent(KkiapayChannels.TRANSACTION_SUCCESS)
    async orderStatutReady(payload: OrderCreatedEvent) {
        console.log("==========================================================================\nJe récupérer les informations du paiement par webhook de kkipay\n==========================================================================")
        console.log(payload)
    }

}
