import { Module } from '@nestjs/common';
import { ProspectController } from './controllers/prospect.controller';
import { ProspectService } from './services/prospect.service';
import { ProspectListenerService } from './listeners/prospect-listener.service';

/**
 * Module « Base de Données » — captation & conversion des clients Glovo/Yango.
 * (PrismaService, SettingsService, TwilioService sont fournis globalement.)
 */
@Module({
  controllers: [ProspectController],
  providers: [ProspectService, ProspectListenerService],
  exports: [ProspectService],
})
export class ProspectModule {}
