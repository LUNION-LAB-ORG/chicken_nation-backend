import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDishRestaurantDto {
  @ApiProperty({ description: 'ID du plat' })
  @IsNotEmpty()
  @IsUUID()
  dish_id: string;

  @ApiProperty({ description: 'ID du restaurant' })
  @IsNotEmpty()
  @IsUUID()
  restaurant_id: string;
}