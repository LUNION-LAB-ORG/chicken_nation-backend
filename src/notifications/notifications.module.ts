import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { EmailNotificationService } from 'src/notifications/services/email-notification.service';
import { PushNotificationService } from 'src/notifications/services/push-notification.service';
import { SmsNotificationService } from 'src/notifications/services/sms-notification.service';
import { AdminNotificationService } from 'src/notifications/services/admin-notification.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { AdminNotificationsController } from 'src/notifications/controllers/admin-notifications.controller';
import { Notification } from 'src/notifications/entities/notification.entity';
import { NotificationPreference } from 'src/notifications/entities/notification-preference.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, NotificationPreference]),
    ConfigModule,
  ],
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
