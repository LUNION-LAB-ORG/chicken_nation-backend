import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { PrismaService } from 'src/database/services/prisma.service';


@Injectable()
export class TurboListenerService {

    constructor(private readonly prisma: PrismaService) { }

    @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
    async orderStatutReady(payload: OrderCreatedEvent) {

        // if (order && order.status === OrderStatus.READY) {
        //     const adresse = JSON.parse(order.address?.toLocaleString() ?? "{}");
        //     const mockerData = {
        //         "zoneId": "92f7c2d6-1a52-4a60-92a4-0d5f41d44561",// Zone est liée au système de Turbo
        //         "numero": order.reference,
        //         "destinataire": {
        //             "nom": order.fullname,
        //             "telephone": order.phone,
        //             "email": order.email
        //         },
        //         "lieuRecuperation": {
        //             "latitude": order.restaurant.latitude,
        //             "longitude": order.restaurant.longitude,
        //             "adresse": order.restaurant.address
        //         },
        //         "lieuLivraison": {
        //             "latitude": adresse.latitude,
        //             "longitude": adresse.longitude,
        //             "adresse": adresse.address
        //         },
        //         "modePaiement": this.mappingMethodPayment[order.paiements[0].mode],
        //         "prix": order.amount,
        //         "livraisonPaye": order.paied,
        //     }

        //     const response = await fetch(`${this.turboApi.CREATION_COURSE}?apikey=${this.turboApiKey}`, {
        //         method: 'POST',
        //         headers: {
        //             'Content-Type': 'application/json',
        //             // 'Authorization': `Bearer ${this.turboApiKey}`,
        //         },
        //         body: JSON.stringify(mockerData),
        //     });

        //     console.log(response);

        //     /*
        //     if (mockerData.numero==Commande.numero){
        //         //Creation de la course
        //     }
        //     */
        // }
    }



}
