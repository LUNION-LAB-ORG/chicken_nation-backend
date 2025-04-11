import { Module } from '@nestjs/common';
import { PaiementsService } from 'src/paiements/services/paiements.service';
import { PaiementsController } from 'src/paiements/controllers/paiements.controller';


@Module({
  imports: [],
  controllers: [PaiementsController],
  providers: [PaiementsService],
})
export class PaiementsModule { }
