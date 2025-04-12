import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SpecialOfferService } from 'src/modules/special-offer/services/special-offer.service';
import { CreateSpecialOfferDto } from 'src/modules/special-offer/dto/create-special-offer.dto';
import { UpdateSpecialOfferDto } from 'src/modules/special-offer/dto/update-special-offer.dto';

@Controller('special-offer')
export class SpecialOfferController {
  constructor(private readonly specialOfferService: SpecialOfferService) { }

  @Post()
  create(@Body() createSpecialOfferDto: CreateSpecialOfferDto) {
    return this.specialOfferService.create(createSpecialOfferDto);
  }

  @Get()
  findAll() {
    return this.specialOfferService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.specialOfferService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateSpecialOfferDto: UpdateSpecialOfferDto) {
    return this.specialOfferService.update(+id, updateSpecialOfferDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.specialOfferService.remove(+id);
  }
}
