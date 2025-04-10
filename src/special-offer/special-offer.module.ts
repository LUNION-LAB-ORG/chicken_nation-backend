import { Module } from '@nestjs/common';
import { SpecialOfferService } from 'src/special-offer/services/special-offer.service';
import { SpecialOfferController } from 'src/special-offer/controllers/special-offer.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SpecialOffer } from 'src/special-offer/entities/special-offer.entity';
import { SpecialOfferDish } from 'src/special-offer/entities/special-offer-dish.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SpecialOffer, SpecialOfferDish])],
  controllers: [SpecialOfferController],
  providers: [SpecialOfferService],
})
export class SpecialOfferModule { }
