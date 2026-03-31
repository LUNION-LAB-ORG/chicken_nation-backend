import { Injectable, Logger } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
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
