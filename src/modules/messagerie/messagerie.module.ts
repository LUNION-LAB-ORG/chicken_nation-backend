import { Module } from '@nestjs/common';
import { ConversationsController } from './controllers/conversations.controller';
import { TicketsController } from './controllers/tickets.controller';
import { MessageService } from './services/message.service';
import { ConversationsService } from './services/conversations.service';
import { MessageController } from './controllers/message.controller';
import { MessageWebSocketService } from './websockets/message-websocket.service';
import { JsonWebTokenModule } from '../../json-web-token/json-web-token.module';
import { ConversationWebsocketsService } from './websockets/conversation-websockets.service';

@Module({
  imports: [JsonWebTokenModule], // TODO: Anderson Pourquoi importer ??
  controllers: [ConversationsController, TicketsController, MessageController],
  providers: [ConversationsService, ConversationWebsocketsService, MessageService, MessageWebSocketService],
})
export class MessagerieModule {}
