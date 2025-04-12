import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SpecialOfferDishService } from 'src/modules/special-offer/services/special-offer-dish.service';
import { CreateSpecialOfferDishDto } from 'src/modules/special-offer/dto/create-special-offer-dish.dto';
import { UpdateSpecialOfferDishDto } from 'src/modules/special-offer/dto/update-special-offer-dish.dto';

@Controller('special-offer-dish')
export class SpecialOfferDishController {
  constructor(private readonly specialOfferDishService: SpecialOfferDishService) {}

  @Post()
  create(@Body() createSpecialOfferDishDto: CreateSpecialOfferDishDto) {
    return this.specialOfferDishService.create(createSpecialOfferDishDto);
  }

  @Get()
  findAll() {
    return this.specialOfferDishService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.specialOfferDishService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateSpecialOfferDishDto: UpdateSpecialOfferDishDto) {
    return this.specialOfferDishService.update(+id, updateSpecialOfferDishDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.specialOfferDishService.remove(+id);
  }
}
