import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateDishRestaurantDto {
  @IsNotEmpty()
  @IsUUID()
  dish_id: string;

  @IsNotEmpty()
  @IsUUID()
  restaurant_id: string;
}