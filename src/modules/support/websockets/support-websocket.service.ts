import { Injectable, Logger } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { agregerReactions } from 'src/common/constantes/emojis-reaction';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { ResponseTicketMessageDto } from '../dtos/response-ticket-message.dto';

@Injectable()
export class SupportWebSocketService {
  private readonly logger = new Logger(SupportWebSocketService.name);
  constructor(private appGateway: AppGateway) {}

  emitNewTicket(ticket: ResponseTicketDto) {
    this.logger.log(`Emitting new ticket event ${ticket.id}`);
    this.appGateway.emitToBackoffice('new:ticket', ticket);

    if (ticket.assignee?.id) {
      this.appGateway.emitToUser(ticket.assignee.id, 'user', 'assigned:ticket', ticket);
    }

    if (ticket.customer?.id) {
      this.appGateway.emitToUser(ticket.customer.id, 'customer', 'created:ticket', ticket);
    }

    if (ticket.order?.restaurantId) {
      this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'new:ticket', ticket);
    }
  }

  emitUpdateTicket(ticket: ResponseTicketDto) {
    this.logger.log(`Emitting update ticket event ${ticket.id}`);
    this.appGateway.emitToBackoffice('update:ticket', ticket);

    // Notifier uniquement l'assigné et le customer concerné (plus de broadcast à tous)
    if (ticket.assignee?.id) {
      this.appGateway.emitToUser(ticket.assignee.id, 'user', 'update:ticket', ticket);
    }

    if (ticket.customer?.id) {
      this.appGateway.emitToUser(ticket.customer.id, 'customer', 'update:ticket', ticket);
    }

    if (ticket.order?.restaurantId) {
      this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'update:ticket', ticket);
    }
  }

  /**
   * Les réactions d'un message de ticket ont changé.
   *
   * ⚠️ Diffusion NOMINATIVE, contrairement aux autres évènements de ce service.
   * Deux raisons. `mine` dépend de qui regarde : une charge unique afficherait
   * « j'ai réagi » chez tout le monde dès qu'une seule personne l'a fait. Et la
   * salle `restaurant_<id>` utilisée ailleurs ici contient AUSSI les livreurs :
   * y publier les réactions d'un message interne les leur livrerait.
   *
   * Le backoffice, lui, reçoit l'évènement globalement : il n'affiche jamais
   * « ma » réaction sur un fil de ticket qu'il ne fait que superviser, et c'est
   * ainsi que tous les autres évènements de tickets lui parviennent.
   */
  /**
   * Un message de ticket a été RETIRÉ.
   *
   * On diffuse le message DÉJÀ nettoyé par le serveur : aucun client n'a à
   * décider quoi masquer, et celui qui l'aurait en cache le remplace tel quel.
   */
  emitTicketMessageSupprime(ticketId: string, message: unknown) {
    this.appGateway.emitToBackoffice('ticket_message:supprime', { ticketId, message });
  }

  emitReactionsChanged(
    ticketId: string,
    messageId: string,
    reactions: { emoji: string; userId?: string | null; customerId?: string | null; delivererId?: string | null }[],
  ) {
    const charge = (pourQui: string | null) => ({
      ticketId,
      messageId,
      reactions: agregerReactions(reactions, pourQui),
    });

    this.appGateway.emitToBackoffice('ticket_message:reactions', charge(null));

    // Chaque personne ayant réagi reçoit SA vue : c'est elle qui a besoin de
    // voir sa propre pastille allumée.
    const vus = new Set<string>();
    for (const r of reactions) {
      if (r.userId && !vus.has(r.userId)) {
        vus.add(r.userId);
        this.appGateway.emitToUser(r.userId, 'user', 'ticket_message:reactions', charge(r.userId));
      }
      if (r.customerId && !vus.has(r.customerId)) {
        vus.add(r.customerId);
        this.appGateway.emitToUser(r.customerId, 'customer', 'ticket_message:reactions', charge(r.customerId));
      }
      if (r.delivererId && !vus.has(r.delivererId)) {
        vus.add(r.delivererId);
        this.appGateway.emitToUser(r.delivererId, 'deliverer', 'ticket_message:reactions', charge(r.delivererId));
      }
    }
  }

  emitNewTicketMessage(
    ticketId: string,
    { message, restaurantId }: { message: ResponseTicketMessageDto; restaurantId: string | null },
  ) {
    this.logger.log(`Emitting new ticket message event for ticket ${ticketId}`);
    const payload = { ticketId, message };

    // Notifier le backoffice
    this.appGateway.emitToBackoffice('new:ticket_message', payload);

    // Notifier uniquement l'auteur opposé (pas de broadcast à tous)
    if (message.authorUser) {
      // Message envoyé par un staff → notifier le customer du ticket
      // Le customer est identifié via le ticket, pas via un broadcast global
    }

    if (message.authorCustomer) {
      // Message envoyé par un customer → notifier le staff assigné
      // Le backoffice reçoit déjà via emitToBackoffice
    }

    if (restaurantId) {
      this.appGateway.emitToRestaurant(restaurantId, 'new:ticket_message', payload);
    }
  }

  emitMessagesRead(ticketId: string) {
    this.logger.log(`Emitting read ticket messages event for ticket ${ticketId}`);
    this.appGateway.emitToBackoffice('read:ticket_messages', { ticketId });
  }
}
