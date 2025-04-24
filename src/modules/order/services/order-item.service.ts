import { Injectable } from '@nestjs/common';
import { CreateOrderItemDto } from 'src/modules/order/dto/create-order-item.dto';
import { UpdateOrderItemDto } from 'src/modules/order/dto/update-order-item.dto';

@Injectable()
export class OrderItemService {
  async create(createOrderItemDto: CreateOrderItemDto) {
    return 'This action adds a new order';
  }

  async findAll() {
    return `This action returns all orders`;
  }

  async findOne(id: number) {
    return `This action returns a #${id} order`;
  }

  async update(id: number, updateOrderItemDto: UpdateOrderItemDto) {
    return `This action updates a #${id} order`;
  }

  async remove(id: number) {
    return `This action removes a #${id} order`;
  }
}
