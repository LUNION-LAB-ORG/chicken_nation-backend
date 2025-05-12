import { Module } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { PaiementsController } from 'src/modules/paiements/controllers/paiements.controller';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';


@Module({
  imports: [KkiapayModule],
  controllers: [PaiementsController],
  providers: [PaiementsService],
  exports: [PaiementsService]
})
export class PaiementsModule { }
