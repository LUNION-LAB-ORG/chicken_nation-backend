import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { FavoriteService } from 'src/modules/customer/services/favorite.service';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';
import { UpdateFavoriteDto } from 'src/modules/customer/dto/update-favorite.dto';

@Controller('favorite')
export class FavoriteController {
  constructor(private readonly favoriteService: FavoriteService) { }

  @Post()
  create(@Body() createFavoriteDto: CreateFavoriteDto) {
    return this.favoriteService.create(createFavoriteDto);
  }

  @Get()
  findAll() {
    return this.favoriteService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.favoriteService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateFavoriteDto: UpdateFavoriteDto) {
    return this.favoriteService.update(+id, updateFavoriteDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.favoriteService.remove(+id);
  }
}
