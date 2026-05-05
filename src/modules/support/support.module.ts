import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';

import { CategoriesTicketController } from './controllers/categories-ticket.controller';
import { DelivererTicketsController } from './controllers/deliverer-tickets.controller';
import { MessagesController } from './controllers/messages.controller';
import { TicketsController } from './controllers/tickets.controller';
import { TicketsConsumer } from './consumers/tickets.consumer';
import { TicketEvent } from './events/ticket.event';
import { TicketListenerService } from './listeners/ticket-listener.service';
import { AssignmentService } from './services/assignment.service';
import { CategoriesTicketService } from './services/categories-ticket.service';
import { DelivererTicketsService } from './services/deliverer-tickets.service';
import { TicketMessageService } from './services/message.service';
import { TicketService } from './services/ticket.service';
import { SupportWebSocketService } from './websockets/support-websocket.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'tickets',
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    // P-chat livreur : nécessaire pour JwtDelivererAuthGuard côté DelivererTicketsController
    AuthDelivererModule,
  ],
  // ⚠ ORDRE IMPORTANT : DelivererTicketsController (`@Controller('tickets/deliverer/me')`)
  // doit être enregistré AVANT TicketsController (`@Controller('tickets')`).
  // Sinon Express matche `/tickets/deliverer` sur le pattern `/tickets/:id` du
  // controller admin et applique le mauvais guard (JwtAuthGuard USER au lieu
  // de JwtDelivererAuthGuard) → 401. Même piège qu'avec DeliverersSelfController.
  controllers: [
    DelivererTicketsController,
    TicketsController,
    MessagesController,
    CategoriesTicketController,
  ],
  providers: [
    TicketService,
    DelivererTicketsService,
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
