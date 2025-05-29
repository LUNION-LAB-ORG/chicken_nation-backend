import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsController } from 'src/modules/notifications/controllers/notifications.controller';
@Module({
  imports: [],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
  ],
  exports: [
    NotificationsService,
  ],
})
export class NotificationsModule {}
