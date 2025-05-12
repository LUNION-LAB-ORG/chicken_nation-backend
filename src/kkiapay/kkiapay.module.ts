import { Module } from '@nestjs/common';
import { KkiapayController } from 'src/kkiapay/kkiapay.controller';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';

@Module({
  controllers: [KkiapayController],
  providers: [KkiapayService],
  exports: [KkiapayService]
})
export class KkiapayModule { }
