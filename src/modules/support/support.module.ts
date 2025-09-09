import { Module } from '@nestjs/common';
import { TicketsController } from './controllers/tickets.controller';
import { TicketService } from './services/ticket.service';
import { TicketMessageService } from './services/message.service';
import { MessagesController } from './controllers/messages.controller';
import { SupportWebSocketService } from './websockets/support-websocket.service';
import { CategoriesTicketService } from './services/categories-ticket.service';
import { CategoriesTicketController } from './controllers/categories-ticket.controller';

@Module({
  controllers: [TicketsController, MessagesController, CategoriesTicketController],
  providers: [TicketService, TicketMessageService, SupportWebSocketService, CategoriesTicketService],
})
export class SupportModule { }
