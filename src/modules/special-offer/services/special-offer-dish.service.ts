import { Injectable } from '@nestjs/common';
import { CreateSpecialOfferDishDto } from 'src/modules/special-offer/dto/create-special-offer-dish.dto';
import { UpdateSpecialOfferDishDto } from 'src/modules/special-offer/dto/update-special-offer-dish.dto';

@Injectable()
export class SpecialOfferDishService {
  create(createSpecialOfferDishDto: CreateSpecialOfferDishDto) {
    return 'This action adds a new specialOfferDish';
  }

  findAll() {
    return `This action returns all specialOfferDish`;
  }

  findOne(id: number) {
    return `This action returns a #${id} specialOfferDish`;
  }

  update(id: number, updateSpecialOfferDishDto: UpdateSpecialOfferDishDto) {
    return `This action updates a #${id} specialOfferDish`;
  }

  remove(id: number) {
    return `This action removes a #${id} specialOfferDish`;
  }
}
