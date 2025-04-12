import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { UpdateDishRestaurantDto } from 'src/modules/menu/dto/update-dish-restaurant.dto';

@Controller('dish-restaurant')
export class DishRestaurantController {
  constructor(private readonly dishRestaurantService: DishRestaurantService) {}

  @Post()
  create(@Body() createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.dishRestaurantService.create(createDishRestaurantDto);
  }

  @Get()
  findAll() {
    return this.dishRestaurantService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.dishRestaurantService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateDishRestaurantDto: UpdateDishRestaurantDto) {
    return this.dishRestaurantService.update(+id, updateDishRestaurantDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.dishRestaurantService.remove(+id);
  }
}
