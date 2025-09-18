import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { TurboService } from 'src/turbo/services/turbo.service';
import { OrderStatus, DeliveryService } from '@prisma/client';


@Injectable()
export class TurboListenerService {

    constructor(private readonly TurboService: TurboService) { }

    @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
    async orderStatutReady(payload: OrderCreatedEvent) {
        console.log("🚀 ~ file: turbo.listener.service.ts:14 ~ TurboListenerService ~ orderStatutReady ~ payload:", payload)
        if (payload.order && payload.order.status === OrderStatus.READY && payload.order.delivery_service === DeliveryService.TURBO) {
            this.TurboService.creerCourse(payload.order.id, "");
        }
    }

}
