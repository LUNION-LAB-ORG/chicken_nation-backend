import { Module } from '@nestjs/common';
import { RetentionCallbackController } from './retention-callback.controller';
import { RetentionCallbackService } from './retention-callback.service';
import { RetentionCallbackReasonController } from './retention-callback-reason.controller';
import { RetentionCallbackReasonService } from './retention-callback-reason.service';
import { RetentionReconquestCheckTask } from './tasks/retention-reconquest-check.task';

@Module({
  controllers: [RetentionCallbackReasonController, RetentionCallbackController],
  providers: [
    RetentionCallbackService,
    RetentionCallbackReasonService,
    RetentionReconquestCheckTask,
  ],
})
export class RetentionCallbackModule {}
