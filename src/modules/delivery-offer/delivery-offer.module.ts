import { Module } from '@nestjs/common';
import { DeliveryOfferController } from './controllers/delivery-offer.controller';
import { DeliveryOfferService } from './services/delivery-offer.service';

@Module({
  controllers: [DeliveryOfferController],
  providers: [DeliveryOfferService],
  exports: [DeliveryOfferService],
})
export class DeliveryOfferModule {}
