import { Injectable } from '@nestjs/common';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';

@Injectable()
export class CustomerService {
  create(createCustomerDto: CreateCustomerDto) {
    return 'This action adds a new customer';
  }

  findAll() {
    return `This action returns all customer`;
  }

  findOne(id: number) {
    return `This action returns a #${id} customer`;
  }

  update(id: number, updateCustomerDto: UpdateCustomerDto) {
    return `This action updates a #${id} customer`;
  }

  remove(id: number) {
    return `This action removes a #${id} customer`;
  }
}
