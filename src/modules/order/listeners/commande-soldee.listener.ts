import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderStatus } from '@prisma/client';
import { PaiementChannels } from 'src/modules/paiements/enums/paiement-channels';
import { OrderService } from '../services/order.service';

export interface CommandeEnAttenteSoldee {
  orderId: string;
  /** Brouillon avant le paiement : le restaurant ne l'a jamais vue. */
  etaitBrouillon: boolean;
  userId: string | null;
  role: string | null;
}

/**
 * COMMANDE EN ATTENTE SOLDÉE PAR UN PAIEMENT AJOUTÉ À LA MAIN (14/11).
 *
 * Le client a payé, le webhook n'a rien confirmé : l'équipe enregistre le
 * paiement (`POST /paiements/add`, onglet Paiement de la commande). Payée,
 * la commande restait en attente, invisible du restaurant. Elle se confirme
 * désormais par le chemin ordinaire de l'acceptation (`updateStatus`) :
 * ACCEPTED, `accepted_at`, cloche, « Nouvelle commande » au restaurant
 * qui ne l'avait jamais vue, sockets, retrait des points utilisés.
 *
 * Écriture conditionnée à l'attente : une commande acceptée entre-temps
 * (webhook arrivé, collègue) n'est pas acceptée une seconde fois.
 *
 * @returns vrai si la commande vient d'être confirmée. Ne lève jamais : le
 *   paiement est déjà enregistré.
 */
@Injectable()
export class CommandeSoldeeListener {
  private readonly logger = new Logger(CommandeSoldeeListener.name);

  constructor(private readonly orderService: OrderService) {}

  @OnEvent(PaiementChannels.COMMANDE_EN_ATTENTE_SOLDEE)
  async confirmer(evenement: CommandeEnAttenteSoldee): Promise<boolean> {
    try {
      await this.orderService.updateStatus(
        evenement.orderId,
        OrderStatus.ACCEPTED,
        { userId: evenement.userId, role: evenement.role },
        { conditionEcriture: { status: OrderStatus.PENDING }, etaitBrouillon: evenement.etaitBrouillon },
      );
      return true;
    } catch (e) {
      this.logger.error(`Commande ${evenement.orderId} payée mais non confirmée : ${(e as Error)?.message}`);
      return false;
    }
  }
}
