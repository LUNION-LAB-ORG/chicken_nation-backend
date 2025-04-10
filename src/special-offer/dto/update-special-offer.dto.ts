import { PartialType } from '@nestjs/swagger';
import { CreateSpecialOfferDto } from './create-special-offer.dto';

export class UpdateSpecialOfferDto extends PartialType(CreateSpecialOfferDto) {}
