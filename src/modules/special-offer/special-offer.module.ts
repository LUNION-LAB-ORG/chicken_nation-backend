import { Module } from '@nestjs/common';
import { SpecialOfferService } from 'src/modules/special-offer/services/special-offer.service';
import { SpecialOfferDishService } from 'src/modules/special-offer/services/special-offer-dish.service';
import { SpecialOfferController } from 'src/modules/special-offer/controllers/special-offer.controller';
import { SpecialOfferDishController } from 'src/modules/special-offer/controllers/special-offer-dish.controller';

@Module({
  imports: [],
  controllers: [SpecialOfferController, SpecialOfferDishController],
  providers: [SpecialOfferService, SpecialOfferDishService],
})
export class SpecialOfferModule { }
