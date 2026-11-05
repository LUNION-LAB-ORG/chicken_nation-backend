import { Module } from '@nestjs/common';
import { TurboController } from './controllers/turbo.controller';
import { TurboService } from './services/turbo.service';
import { TurboWebhookService } from './services/turbo-webhook.service';
import { CommandeFinieListener } from './listeners/commande-finie.listener';

@Module({
  controllers: [TurboController],
  providers: [TurboService, TurboWebhookService, CommandeFinieListener],
  exports: [TurboService, TurboWebhookService]
})
export class TurboModule { }
