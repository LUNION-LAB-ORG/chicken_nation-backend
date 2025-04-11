import { Injectable } from '@nestjs/common';
import { CreateDishDto } from 'src/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/menu/dto/update-dish.dto';

@Injectable()
export class DishService {
  create(createDishDto: CreateDishDto) {
    return 'This action adds a new dish';
  }

  findAll() {
    return `This action returns all dish`;
  }

  findOne(id: number) {
    return `This action returns a #${id} dish`;
  }

  update(id: number, updateDishDto: UpdateDishDto) {
    return `This action updates a #${id} dish`;
  }

  remove(id: number) {
    return `This action removes a #${id} dish`;
  }
}
