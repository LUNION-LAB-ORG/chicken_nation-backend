import { PartialType } from "@nestjs/swagger";
import { CreateSpecialOfferDto } from "src/special-offer/dto/create-special-offer.dto";

export class UpdateSpecialOfferDto extends PartialType(CreateSpecialOfferDto) { }
