import { PartialType } from "@nestjs/swagger";

export class CreateSpecialOfferDishDto {

}

export class UpdateSpecialOfferDishDto extends PartialType(CreateSpecialOfferDishDto) { }
