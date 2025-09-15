import { Module } from '@nestjs/common';
import { TicketsController } from './controllers/tickets.controller';
import { TicketService } from './services/ticket.service';
import { TicketMessageService } from './services/message.service';
import { MessagesController } from './controllers/messages.controller';
import { SupportWebSocketService } from './websockets/support-websocket.service';
import { CategoriesTicketService } from './services/categories-ticket.service';
import { CategoriesTicketController } from './controllers/categories-ticket.controller';
import { BullModule } from '@nestjs/bullmq';
import { TicketEvent } from './events/ticket.event';
import { TicketListenerService } from './listeners/ticket-listener.service';
import { AssignmentService } from './services/assignment.service';
import { TicketsConsumer } from './consumers/tickets.consumer';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'tickets',
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    })
  ],
  controllers: [TicketsController, MessagesController, CategoriesTicketController],
  providers: [
    TicketService,
    TicketMessageService,
    SupportWebSocketService,
    CategoriesTicketService,
    TicketEvent,
    TicketListenerService,
    AssignmentService,
    TicketsConsumer,
  ],
})
export class SupportModule { }
