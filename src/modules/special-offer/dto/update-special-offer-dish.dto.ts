import { PartialType } from "@nestjs/swagger";
import { CreateSpecialOfferDishDto } from "src/modules/special-offer/dto/create-special-offer-dish.dto";

export class UpdateSpecialOfferDishDto extends PartialType(CreateSpecialOfferDishDto) { }
