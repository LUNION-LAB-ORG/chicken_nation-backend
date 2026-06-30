import { PartialType } from '@nestjs/swagger';
import { CreateDeliveryOfferDto } from './create-delivery-offer.dto';

export class UpdateDeliveryOfferDto extends PartialType(CreateDeliveryOfferDto) {}
