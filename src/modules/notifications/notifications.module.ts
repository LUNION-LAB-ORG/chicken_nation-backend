import { Module, Global } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationRecipientsService } from './services/notifications-recipients.service';
import { NotificationsSenderService } from './services/notifications-sender.service';
import { NotificationsListener } from './listeners/notifications.listener';
import { NotificationWebSocketService } from './services/notifications-websocket.service';

@Global()
@Module({
  imports: [],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationRecipientsService, NotificationsListener, NotificationsSenderService, NotificationWebSocketService],
  exports: [
    NotificationsService,
    NotificationsSenderService,
    NotificationRecipientsService,
    NotificationsListener,
    NotificationWebSocketService
  ],
})
export class NotificationsModule { }
