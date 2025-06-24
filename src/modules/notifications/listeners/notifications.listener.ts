import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsSenderService } from '../services/notifications-sender.service';

@Injectable()
export class NotificationsListener {
    constructor(private notificationSenderService: NotificationsSenderService) { }

    // PAIEMENT
    @OnEvent('paiement.annule')
    async handlePaiementAnnule(payload: any) {
        // TODO: Envoyer notification au client paiement annulé
        // await this.notificationSenderService.sendPaiementAnnuleNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }

    @OnEvent('payment.completed')
    async handlePaymentCompleted(payload: { payment: any; order: any; customer: any }) {
        await this.notificationSenderService.handlePaymentCompleted(
            payload.payment,
            payload.order,
            payload.customer
        );
    }

    @OnEvent('paiement.effectue')
    async handlePaiementEffectue(payload: any) {
        // TODO: Envoyer notification au client paiement effectué
        // await this.notificationSenderService.sendPaiementEffectueNotification(
        //   payload.customer.id,
        //   payload.paiement_id,
        //   payload.customer.name
        // );
    }
}