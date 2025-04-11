import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { DishSupplementService } from 'src/menu/services/dish-supplement.service';
import { CreateDishSupplementDto } from 'src/menu/dto/create-dish-supplement.dto';
import { UpdateDishSupplementDto } from 'src/menu/dto/update-dish-supplement.dto';

@Controller('dish-supplement')
export class DishSupplementController {
  constructor(private readonly dishSupplementService: DishSupplementService) {}

  @Post()
  create(@Body() createDishSupplementDto: CreateDishSupplementDto) {
    return this.dishSupplementService.create(createDishSupplementDto);
  }

  @Get()
  findAll() {
    return this.dishSupplementService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.dishSupplementService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateDishSupplementDto: UpdateDishSupplementDto) {
    return this.dishSupplementService.update(+id, updateDishSupplementDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.dishSupplementService.remove(+id);
  }
}
