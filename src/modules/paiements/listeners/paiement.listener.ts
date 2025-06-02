import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { PrismaService } from 'src/database/services/prisma.service';

@Injectable()
export class PaymentListener {
    constructor(private prisma: PrismaService) { }

    @OnEvent('order.created')
    async handleOrderCreated(payload: OrderCreatedEvent) {
        if (payload.payment_id) {
            await this.prisma.paiement.update({
                where: { id: payload.payment_id },
                data: { order_id: payload.order.id },
            });

            console.log(`Payment updated ${payload.payment_id}`);
        }
    }
}