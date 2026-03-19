import { Module } from '@nestjs/common';
import { OnesignalService } from './onesignal.service';
import { OnesignalController } from './onesignal.controller';
import { OnesignalTagsTask } from './tasks/onesignal-tags.task';
import { OnesignalScheduledTask } from './tasks/onesignal-scheduled.task';
import { ScheduledNotificationService } from './scheduled-notification.service';
import { SettingsModule } from 'src/modules/settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [OnesignalController],
  providers: [
    OnesignalService,
    ScheduledNotificationService,
    OnesignalTagsTask,
    OnesignalScheduledTask,
  ],
  exports: [OnesignalService],
})
export class OnesignalModule {}
