import { Module } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { PaiementsController } from 'src/modules/paiements/controllers/paiements.controller';


@Module({
  imports: [],
  controllers: [PaiementsController],
  providers: [PaiementsService],
})
export class PaiementsModule { }
