import { Module } from '@nestjs/common';
import { CrmModule } from 'src/modules/crm/crm.module';
import { ProspectController } from './controllers/prospect.controller';
import { ProspectService } from './services/prospect.service';
import { ProspectScanService } from './services/prospect-scan.service';
import { ProspectListenerService } from './listeners/prospect-listener.service';

/**
 * Captures Glovo/Yango par les caissiers : chaque capture rejoint le CRM, qui
 * porte désormais les appels, les coupons et les chiffres. Les anciennes
 * routes de l'appli caisse passent par le CRM pendant la transition.
 * (PrismaService, SettingsService, TwilioService sont fournis globalement.)
 */
@Module({
  imports: [CrmModule],
  controllers: [ProspectController],
  providers: [ProspectService, ProspectScanService, ProspectListenerService],
  exports: [ProspectService],
})
export class ProspectModule {}
