import { Module } from '@nestjs/common';
import { OnesignalService } from './onesignal.service';
import { OnesignalController } from './onesignal.controller';
import { OnesignalTagsTask } from './tasks/onesignal-tags.task';
import { SettingsModule } from 'src/modules/settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [OnesignalController],
  providers: [OnesignalService, OnesignalTagsTask],
  exports: [OnesignalService],
})
export class OnesignalModule {}
