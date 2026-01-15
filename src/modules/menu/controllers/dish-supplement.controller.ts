import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateDishSupplementDto } from 'src/modules/menu/dto/create-dish-supplement.dto';
import { DishSupplementService } from 'src/modules/menu/services/dish-supplement.service';

@ApiTags('Dish Supplements')
@ApiBearerAuth()
@Controller('dish-supplements')
export class DishSupplementController {
  constructor(private readonly dishSupplementService: DishSupplementService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle relation entre plat et supplément' })
  @Post()
  create(@Body() createDishSupplementDto: CreateDishSupplementDto) {
    return this.dishSupplementService.create(createDishSupplementDto);
  }

  @ApiOperation({ summary: 'Récupération de toutes les relations entre plats et suppléments' })
  @Get()
  findAll() {
    return this.dishSupplementService.findAll();
  }

  @ApiOperation({ summary: 'Suppression d\'une relation entre plat et supplément' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.dishSupplementService.remove(id);
  }

  @ApiOperation({ summary: 'Suppression d\'une relation entre plat et supplément' })
  @Delete('dish/:dishId/supplement/:supplementId')
  removeByDishAndSupplement(
    @Param('dishId') dishId: string,
    @Param('supplementId') supplementId: string,
  ) {
    return this.dishSupplementService.removeByDishAndSupplement(dishId, supplementId);
  }
}