import { Module, Global } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationsSenderService } from './services/notifications-sender.service';
import { NotificationsListener } from './listeners/notifications.listener';
import { NotificationsWebSocketService } from './websockets/notifications-websocket.service';
import { NotificationRecipientService } from './recipients/notification-recipient.service';
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService,
    NotificationRecipientService,
    NotificationsListener,
    NotificationsSenderService,
    NotificationsWebSocketService],
  exports: [
    NotificationsService,
    NotificationsSenderService,
    NotificationRecipientService,
    NotificationsListener,
    NotificationsWebSocketService
  ],
})
export class NotificationsModule { }
