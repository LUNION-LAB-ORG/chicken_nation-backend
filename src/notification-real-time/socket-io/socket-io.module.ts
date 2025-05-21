import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PositionEventsGateway } from './gateways/position-events.gateway';
import { ChatEventsGateway } from './gateways/chat-events.gateway';
import { PositionEventsService } from './services/position-events.service';
import { NotificationService } from './services/notification-events.service';
import { NotificationGateway } from './gateways/notification-events.gateway';

@Module({
  imports: [ConfigModule],
  providers: [
    PositionEventsService,
    PositionEventsGateway,
    ChatEventsGateway,
    NotificationService,
    NotificationGateway
  ],
  exports: [
    PositionEventsService,
    PositionEventsGateway,
    ChatEventsGateway,
    NotificationService,
    NotificationGateway
  ],
})
export class SocketIoModule { }