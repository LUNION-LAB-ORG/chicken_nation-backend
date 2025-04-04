import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { NotificationsService } from './services/notifications.service';
import { EmailNotificationService } from './services/email-notification.service';
import { PushNotificationService } from './services/push-notification.service';
import { SmsNotificationService } from './services/sms-notification.service';
import { AdminNotificationService } from './services/admin-notification.service';
import { NotificationsController } from './controllers/notifications.controller';
import { AdminNotificationsController } from './controllers/admin-notifications.controller';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';

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
