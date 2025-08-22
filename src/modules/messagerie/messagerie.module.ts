import { Module } from '@nestjs/common';
import { ConversationsController } from './controllers/conversations.controller';
import { TicketsController } from './controllers/tickets.controller';
import { MessageService } from './services/message.service';
import { ConversationsService } from './services/conversations.service';
import { MessageController } from './controllers/message.controller';

@Module({
  imports: [],
  controllers: [ConversationsController, TicketsController, MessageController],
  providers: [ConversationsService, MessageService]
})
export class MessagerieModule {}
