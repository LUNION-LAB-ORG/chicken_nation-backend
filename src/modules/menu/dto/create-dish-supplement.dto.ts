import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateDishSupplementDto {
  @IsNotEmpty()
  @IsUUID()
  dish_id: string;

  @IsNotEmpty()
  @IsUUID()
  supplement_id: string;
}