import { PartialType } from '@nestjs/swagger';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';

export class UpdateDishRestaurantDto extends PartialType(CreateDishRestaurantDto) {}
