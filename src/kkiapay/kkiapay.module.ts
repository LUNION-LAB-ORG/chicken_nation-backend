import { Module } from '@nestjs/common';
import { KkiapayController } from 'src/kkiapay/kkiapay.controller';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';

@Module({
  imports: [PaiementsModule],
  controllers: [KkiapayController],
  providers: [KkiapayService],
  exports: [KkiapayService]
})
export class KkiapayModule { }
