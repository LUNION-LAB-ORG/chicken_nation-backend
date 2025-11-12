import { Module } from '@nestjs/common';
import { KkiapayController } from 'src/kkiapay/kkiapay.controller';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { KkiapayEvent } from 'src/kkiapay/kkiapay.event';

@Module({
  controllers: [KkiapayController],
  providers: [KkiapayService, KkiapayEvent],
  exports: [KkiapayService]
})
export class KkiapayModule { }
