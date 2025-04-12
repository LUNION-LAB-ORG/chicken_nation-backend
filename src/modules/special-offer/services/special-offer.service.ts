import { Injectable } from '@nestjs/common';
import { CreateSpecialOfferDto } from 'src/modules/special-offer/dto/create-special-offer.dto';
import { UpdateSpecialOfferDto } from 'src/modules/special-offer/dto/update-special-offer.dto';

@Injectable()
export class SpecialOfferService {
  create(createSpecialOfferDto: CreateSpecialOfferDto) {
    return 'This action adds a new specialOffer';
  }

  findAll() {
    return `This action returns all specialOffer`;
  }

  findOne(id: number) {
    return `This action returns a #${id} specialOffer`;
  }

  update(id: number, updateSpecialOfferDto: UpdateSpecialOfferDto) {
    return `This action updates a #${id} specialOffer`;
  }

  remove(id: number) {
    return `This action removes a #${id} specialOffer`;
  }
}
