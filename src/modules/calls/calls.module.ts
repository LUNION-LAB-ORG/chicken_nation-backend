import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallsService } from './services/calls.service';
import { CallsConfigService } from './services/calls-config.service';
import { LunionMeetService } from './services/lunion-meet.service';

/**
 * Appels audio internes (Lunion Meet).
 * Dépendances globales : PrismaService (DatabaseModule), SettingsService,
 * AppGateway (SocketIoModule @Global), ConfigService — aucun import requis.
 */
@Module({
  controllers: [CallsController],
  providers: [CallsService, CallsConfigService, LunionMeetService],
})
export class CallsModule {}
