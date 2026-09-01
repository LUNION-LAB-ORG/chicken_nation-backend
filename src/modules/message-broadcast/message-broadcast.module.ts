import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CustomerAudienceService } from 'src/common/services/customer-audience.service';
import { S3Module } from 'src/s3/s3.module';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';
import { MessageBroadcastConsumer } from './consumers/message-broadcast.consumer';
import { MessageBroadcastController } from './message-broadcast.controller';
import { MessageBroadcastService } from './message-broadcast.service';
import { MessageBroadcastScheduledTask } from './tasks/message-broadcast-scheduled.task';

@Module({
  imports: [
    S3Module,
    ExpoPushModule,
    BullModule.registerQueue({
      name: 'message-broadcast',
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    }),
  ],
  controllers: [MessageBroadcastController],
  providers: [
    MessageBroadcastService,
    MessageBroadcastConsumer,
    MessageBroadcastScheduledTask,
    CustomerAudienceService,
  ],
  exports: [MessageBroadcastService],
})
export class MessageBroadcastModule {}
