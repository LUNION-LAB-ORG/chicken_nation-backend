import { Injectable, Logger } from "@nestjs/common";
import { AppGateway } from "src/socket-io/gateways/app.gateway";
import { ResponseTicketDto } from "../dtos/response-ticket.dto";
import { ResponseTicketMessageDto } from "../dtos/response-ticket-message.dto";

@Injectable()
export class SupportWebSocketService {
  private readonly logger = new Logger(SupportWebSocketService.name);
  constructor(private appGateway: AppGateway) { }

  emitNewTicket(ticket: ResponseTicketDto) {
    this.logger.log(`Emitting new ticket event ${ticket.id}`);
    this.appGateway.emitToBackoffice('new:ticket', ticket);

    if (ticket.assignee?.id) {
      this.logger.log(`Emitting assigned ticket event ${ticket.id} to user ${ticket.assignee.id}`);
      this.appGateway.emitToUser(ticket.assignee.id, 'user', 'assigned:ticket', ticket);
    }

    if (ticket.customer?.id) {
      this.logger.log(`Emitting created ticket event ${ticket.id} to customer ${ticket.customer.id}`);
      this.appGateway.emitToUser(ticket.customer.id, 'customer', 'created:ticket', ticket);
    }

    // notifier le restaurant dont la commande est liée au ticket
    if (ticket.order?.restaurantId) {
      this.logger.log(`Emitting new ticket event ${ticket.id} to restaurant ${ticket.order.restaurantId}`);
      this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'new:ticket', ticket);
    }
  }

  emitUpdateTicket(ticket: ResponseTicketDto) {
    this.logger.log(`Emitting update ticket event ${ticket.id}`);
    this.appGateway.emitToBackoffice('update:ticket', ticket);

    if (ticket.assignee?.id) {
      this.logger.log(`Emitting assigned ticket event ${ticket.id} to user ${ticket.assignee.id}`);
      this.appGateway.emitToUser(ticket.assignee.id, 'user', 'assigned:ticket', ticket);
      this.appGateway.emitToUserType('customers', 'update:ticket', ticket);
    }

    if (ticket.customer?.id) {
      this.logger.log(`Emitting updated ticket event ${ticket.id} to customer ${ticket.customer.id}`);
      this.appGateway.emitToUser(ticket.customer.id, 'customer', 'update:ticket', ticket);
      this.appGateway.emitToUserType('users', 'update:ticket', ticket);
    }

    // notifier le restaurant dont la commande est liée au ticket
    if (ticket.order?.restaurantId) {
      this.logger.log(`Emitting update ticket event ${ticket.id} to restaurant ${ticket.order.restaurantId}`);
      this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'update:ticket', ticket);
    }
  }

  emitNewTicketMessage(ticketId: string, { message, restaurantId }: { message: ResponseTicketMessageDto, restaurantId: string }) {
    this.logger.log(`Emitting new ticket message event for ticket ${ticketId}`);
    this.appGateway.emitToBackoffice('new:ticket_message', { ticketId, message });

    if (message.authorUser) {
      this.logger.log(`Emitting new ticket message event for ticket ${ticketId} to user ${message.authorUser.id}`);
      this.appGateway.emitToUser(message.authorUser.id, 'user', 'new:ticket_message', { ticketId, message });
      this.appGateway.emitToUserType('customers', 'new:ticket_message', { ticketId, message });
    }

    if (message.authorCustomer) {
      this.logger.log(`Emitting new ticket message event for ticket ${ticketId} to customer ${message.authorCustomer.id}`);
      this.appGateway.emitToUser(message.authorCustomer.id, 'customer', 'new:ticket_message', { ticketId, message });
      this.appGateway.emitToUserType('users', 'new:ticket_message', { ticketId, message });
    }

    if (restaurantId) {
      this.logger.log(`Emitting new ticket message event for ticket ${ticketId} to restaurant ${restaurantId}`);
      this.appGateway.emitToRestaurant(restaurantId, 'new:ticket_message', { ticketId, message });
    }
  }

  emitMessagesRead(ticketId: string) {
    this.logger.log(`Emitting read ticket messages event for ticket ${ticketId}`);
    this.appGateway.emitToBackoffice('read:ticket_messages', { ticketId });
    this.appGateway.emitToUserType('customers', 'read:ticket_messages', { ticketId });
  }
}