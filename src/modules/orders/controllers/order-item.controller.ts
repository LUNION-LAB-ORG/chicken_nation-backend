import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { OrderItemService } from 'src/modules/orders/services/order-item.service';
import { CreateOrderItemDto } from 'src/modules/orders/dto/create-order-item.dto';
import { UpdateOrderItemDto } from 'src/modules/orders/dto/update-order-item.dto';

@Controller('order-item')
export class OrderItemController {
  constructor(private readonly orderItemService: OrderItemService) { }

  @Post()
  create(@Body() createOrderItemDto: CreateOrderItemDto) {
    return this.orderItemService.create(createOrderItemDto);
  }

  @Get()
  findAll() {
    return this.orderItemService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orderItemService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateOrderItemDto: UpdateOrderItemDto) {
    return this.orderItemService.update(+id, updateOrderItemDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.orderItemService.remove(+id);
  }
}
