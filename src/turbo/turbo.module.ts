import { Module } from '@nestjs/common';
import { TurboController } from './controllers/turbo.controller';
import { TurboService } from './services/turbo.service';
import { TurboWebhookService } from './services/turbo-webhook.service';

@Module({
  controllers: [TurboController],
  providers: [TurboService, TurboWebhookService],
  exports: [TurboService, TurboWebhookService]
})
export class TurboModule { }
