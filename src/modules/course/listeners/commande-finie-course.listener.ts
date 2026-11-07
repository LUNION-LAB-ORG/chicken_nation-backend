import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderStatus, OrderType } from '@prisma/client';

import { OrderChannels } from 'src/modules/order/enums/order-channels';
import type { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';

import { DetachementCommandeService } from '../services/detachement-commande.service';

const STATUTS_COMMANDE_FINIE: OrderStatus[] = [OrderStatus.COLLECTED, OrderStatus.COMPLETED];

/**
 * Règle du 07/11 : terminer une commande termine sa course, jamais l'inverse.
 *
 * Commande à livrer récupérée ou terminée, quel que soit le geste (« Livrée au
 * client » de la caisse, statut du backoffice, « Terminer la commande » de
 * l'administrateur) : sa livraison se ferme et, s'il ne reste aucun autre
 * client, sa course se termine. Les autres clients de la course restent à
 * livrer.
 *
 * Dans l'autre sens, la fin d'une course n'écrit aucune commande
 * (`checkCourseCompletion`). Seul le code du client validé par le livreur
 * change son statut : payée, elle est terminée ; sinon récupérée, à encaisser.
 *
 * Ne passent pas ici : la validation par code, qui ferme déjà la livraison, et
 * l'encaissement, qui ne dit pas que le client est servi (le livreur peut être
 * en route). Course confiée à Turbo : `CommandeFinieListener` du module Turbo.
 */
@Injectable()
export class CommandeFinieCourseListener {
  constructor(private readonly detachement: DetachementCommandeService) {}

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async onStatutCommande(payload: OrderCreatedEvent) {
    const order = payload?.order;
    if (!order || order.type !== OrderType.DELIVERY || !STATUTS_COMMANDE_FINIE.includes(order.status)) return;
    await this.detachement.fermerLivraisonTerminee({ orderId: order.id, reference: order.reference });
  }
}
