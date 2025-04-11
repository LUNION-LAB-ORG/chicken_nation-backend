import { Injectable } from '@nestjs/common';
import { CreateSupplementDto } from 'src/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/menu/dto/update-supplement.dto';

@Injectable()
export class SupplementService {
  create(createSupplementDto: CreateSupplementDto) {
    return 'This action adds a new supplement';
  }

  findAll() {
    return `This action returns all supplement`;
  }

  findOne(id: number) {
    return `This action returns a #${id} supplement`;
  }

  update(id: number, updateSupplementDto: UpdateSupplementDto) {
    return `This action updates a #${id} supplement`;
  }

  remove(id: number) {
    return `This action removes a #${id} supplement`;
  }
}
