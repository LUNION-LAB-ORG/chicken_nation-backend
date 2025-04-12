import { Injectable } from '@nestjs/common';
import { CreateDishSupplementDto } from 'src/modules/menu/dto/create-dish-supplement.dto';
import { UpdateDishSupplementDto } from 'src/modules/menu/dto/update-dish-supplement.dto';

@Injectable()
export class DishSupplementService {
  create(createDishSupplementDto: CreateDishSupplementDto) {
    return 'This action adds a new dishSupplement';
  }

  findAll() {
    return `This action returns all dishSupplement`;
  }

  findOne(id: number) {
    return `This action returns a #${id} dishSupplement`;
  }

  update(id: number, updateDishSupplementDto: UpdateDishSupplementDto) {
    return `This action updates a #${id} dishSupplement`;
  }

  remove(id: number) {
    return `This action removes a #${id} dishSupplement`;
  }
}
