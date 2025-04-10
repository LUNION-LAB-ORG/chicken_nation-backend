import { Injectable } from '@nestjs/common';
import { CreatePaiementDto } from 'src/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/paiements/dto/update-paiement.dto';

@Injectable()
export class PaiementsService {
  create(createPaiementDto: CreatePaiementDto) {
    return 'This action adds a new paiement';
  }

  findAll() {
    return `This action returns all paiements`;
  }

  findOne(id: number) {
    return `This action returns a #${id} paiement`;
  }

  update(id: number, updatePaiementDto: UpdatePaiementDto) {
    return `This action updates a #${id} paiement`;
  }

  remove(id: number) {
    return `This action removes a #${id} paiement`;
  }
}
