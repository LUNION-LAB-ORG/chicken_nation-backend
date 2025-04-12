import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { EmailNotificationService } from 'src/modules/notifications/services/email-notification.service';
import { PushNotificationService } from 'src/modules/notifications/services/push-notification.service';
import { SmsNotificationService } from 'src/modules/notifications/services/sms-notification.service';
import { AdminNotificationService } from 'src/modules/notifications/services/admin-notification.service';
import { NotificationsController } from 'src/modules/notifications/controllers/notifications.controller';
import { AdminNotificationsController } from 'src/modules/notifications/controllers/admin-notifications.controller';

@Module({
  imports: [],
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationsService,
    EmailNotificationService,
    PushNotificationService,
    SmsNotificationService,
    AdminNotificationService,
  ],
  exports: [
    NotificationsService,
    EmailNotificationService,
    PushNotificationService,
    SmsNotificationService,
    AdminNotificationService,
  ],
})
export class NotificationsModule {}
