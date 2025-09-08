import { Module } from '@nestjs/common';
import { TicketsController } from './controllers/tickets.controller';
import { TicketService } from './services/ticket.service';
import { TicketMessageService } from './services/message.service';
import { MessagesController } from './controllers/messages.controller';

@Module({
  controllers: [TicketsController, MessagesController],
  providers: [TicketService, TicketMessageService]
})
export class SupportModule { }
