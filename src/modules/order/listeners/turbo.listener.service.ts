import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { TurboService } from 'src/turbo/services/turbo.service';
import { OrderStatus, DeliveryService } from '@prisma/client';


@Injectable()
export class TurboListenerService {

    constructor(private readonly turboService: TurboService) { }

    @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
    async orderStatutReady(payload: OrderCreatedEvent) {
        if (payload.order && payload.order.status === OrderStatus.READY && payload.order.delivery_service === DeliveryService.TURBO) {
            const retour = this.turboService.creerCourse(payload.order.id, payload.order.restaurant.apikey ?? "");
        }
    }

}
