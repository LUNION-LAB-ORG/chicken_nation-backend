import { Injectable } from "@nestjs/common";
import { AppGateway } from "src/socket-io/gateways/app.gateway";
import { ResponseTicketDto } from "../dtos/response-ticket.dto";
import { ResponseTicketMessageDto } from "../dtos/response-ticket-message.dto";

@Injectable()
export class SupportWebSocketService {
    constructor(private appGateway: AppGateway) { }

    emitNewTicket(ticket: ResponseTicketDto) {
        this.appGateway.emitToBackoffice('new:ticket', ticket);

        if (ticket.assignee?.id) {
            this.appGateway.emitToUser(ticket.assignee.id, 'user', 'assigned:ticket', ticket);
        }

        if (ticket.customer?.id) {
            this.appGateway.emitToUser(ticket.customer.id, 'customer', 'created:ticket', ticket);
        }

        // notifier le restaurant dont la commande est liée au ticket
        if (ticket.order?.restaurantId) {
            this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'new:ticket', ticket);
        }
    }

    emitUpdateTicket(ticket: ResponseTicketDto) {
        this.appGateway.emitToBackoffice('update:ticket', ticket);

        if (ticket.assignee?.id) {
            this.appGateway.emitToUser(ticket.assignee.id, 'user', 'assigned:ticket', ticket);
        }

        if (ticket.customer?.id) {
            this.appGateway.emitToUser(ticket.customer.id, 'customer', 'update:ticket', ticket);
        }

        // notifier le restaurant dont la commande est liée au ticket
        if (ticket.order?.restaurantId) {
            this.appGateway.emitToRestaurant(ticket.order.restaurantId, 'update:ticket', ticket);
        }
    }

    emitNewTicketMessage(ticketId: string, { message, restaurantId }: { message: ResponseTicketMessageDto, restaurantId: string }) {
        this.appGateway.emitToBackoffice('new:ticket_message', { ticketId, message });

        if (message.authorUser) {
            this.appGateway.emitToUser(message.authorUser.id, 'user', 'new:ticket_message', { ticketId, message });
        }

        if (message.authorCustomer) {
            this.appGateway.emitToUser(message.authorCustomer.id, 'customer', 'new:ticket_message', { ticketId, message });
        }

        if (restaurantId) {
            this.appGateway.emitToRestaurant(restaurantId, 'new:ticket_message', { ticketId, message });
        }
    }
}