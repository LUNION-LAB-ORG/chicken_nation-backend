import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CustomerAudienceService } from 'src/common/services/customer-audience.service';
import { MessageBroadcastConsumer } from './consumers/message-broadcast.consumer';
import { MessageBroadcastController } from './message-broadcast.controller';
import { MessageBroadcastService } from './message-broadcast.service';
import { MessageBroadcastScheduledTask } from './tasks/message-broadcast-scheduled.task';

@Module({
  imports: [
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
