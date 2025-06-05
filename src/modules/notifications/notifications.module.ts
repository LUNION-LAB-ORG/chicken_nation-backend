import { Module, Global } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationRecipientsService } from './services/notifications-recipients.service';
import { NotificationsSenderService } from './services/notifications-sender.service';
import { NotificationsListener } from './listeners/notifications.listener';
import { NotificationsWebSocketService } from './services/notifications-websocket.service';

@Global()
@Module({
  imports: [],
  controllers: [NotificationsController],
  providers: [NotificationsService,
    NotificationRecipientsService,
    NotificationsListener,
    NotificationsSenderService,
    NotificationsWebSocketService],
  exports: [
    NotificationsService,
    NotificationsSenderService,
    NotificationRecipientsService,
    NotificationsListener,
    NotificationsWebSocketService
  ],
})
export class NotificationsModule { }
