import { Module } from '@nestjs/common';
import { PaiementsService } from 'src/paiements/services/paiements.service';
import { PaiementsController } from 'src/paiements/controllers/paiements.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Paiement } from 'src/paiements/entities/paiement.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Paiement])],
  controllers: [PaiementsController],
  providers: [PaiementsService],
})
export class PaiementsModule { }
