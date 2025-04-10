import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { PaiementsService } from 'src/paiements/services/paiements.service';
import { CreatePaiementDto } from 'src/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/paiements/dto/update-paiement.dto';

@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) {}

  @Post()
  create(@Body() createPaiementDto: CreatePaiementDto) {
    return this.paiementsService.create(createPaiementDto);
  }

  @Get()
  findAll() {
    return this.paiementsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePaiementDto: UpdatePaiementDto) {
    return this.paiementsService.update(+id, updatePaiementDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(+id);
  }
}
