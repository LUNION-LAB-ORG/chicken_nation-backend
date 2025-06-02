import { Module, Global } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationRecipientsService } from './services/notifications-recipients.service';

@Global()
@Module({
  imports: [],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationRecipientsService],
  exports: [
    NotificationsService,
    NotificationRecipientsService
  ],
})
export class NotificationsModule { }
