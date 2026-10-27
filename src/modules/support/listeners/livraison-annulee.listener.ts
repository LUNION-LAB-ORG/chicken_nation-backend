import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  LIVRAISON_ANNULEE_PAR_LIVREUR,
  LivraisonAnnuleeParLivreurPayload,
} from 'src/modules/course/events/livraison-annulee.event';

import { DelivererTicketsService } from '../services/deliverer-tickets.service';

/**
 * « Annuler » de la feuille « Problème » du livreur (27/10) : la livraison du
 * client est annulée (jamais la commande), le personnel est prévenu par un
 * ticket du livreur, priorité haute, commande liée (centre d'appels et
 * restaurant de la commande).
 *
 * L'événement n'est émis qu'une fois, après l'écriture de l'annulation : un
 * rejeu ne crée pas de second ticket. Un échec du ticket est journalisé et
 * avalé : il n'annule jamais l'annulation.
 */
@Injectable()
export class LivraisonAnnuleeListener {
  private readonly logger = new Logger(LivraisonAnnuleeListener.name);

  constructor(private readonly tickets: DelivererTicketsService) {}

  @OnEvent(LIVRAISON_ANNULEE_PAR_LIVREUR)
  async creerTicket(payload: LivraisonAnnuleeParLivreurPayload): Promise<void> {
    try {
      await this.tickets.creerTicketAnnulation(payload);
    } catch (err) {
      this.logger.error(
        `Ticket de la livraison annulée ${payload?.order_reference ?? payload?.delivery_id} impossible : ` +
          `${(err as Error)?.message ?? err}`,
      );
    }
  }
}
