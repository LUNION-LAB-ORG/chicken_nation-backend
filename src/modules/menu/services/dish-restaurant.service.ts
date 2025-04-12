import { Injectable } from '@nestjs/common';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { UpdateDishRestaurantDto } from 'src/modules/menu/dto/update-dish-restaurant.dto';

@Injectable()
export class DishRestaurantService {
  create(createDishRestaurantDto: CreateDishRestaurantDto) {
    return 'This action adds a new dishRestaurant';
  }

  findAll() {
    return `This action returns all dishRestaurant`;
  }

  findOne(id: number) {
    return `This action returns a #${id} dishRestaurant`;
  }

  update(id: number, updateDishRestaurantDto: UpdateDishRestaurantDto) {
    return `This action updates a #${id} dishRestaurant`;
  }

  remove(id: number) {
    return `This action removes a #${id} dishRestaurant`;
  }
}
