import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { OrderItemService } from 'src/modules/order/services/order-item.service';
import { CreateOrderItemDto } from 'src/modules/order/dto/create-order-item.dto';
import { UpdateOrderItemDto } from 'src/modules/order/dto/update-order-item.dto';

@Controller('order-item')
export class OrderItemController {
  constructor(private readonly orderItemService: OrderItemService) { }

  // @Post()
  // create(@Body() createOrderItemDto: CreateOrderItemDto) {
  //   return this.orderItemService.create(createOrderItemDto);
  // }

  // @Get()
  // findAll() {
  //   return this.orderItemService.findAll();
  // }

  // @Get(':id')
  // findOne(@Param('id') id: string) {
  //   return this.orderItemService.findOne(+id);
  // }

  // @Patch(':id')
  // update(@Param('id') id: string, @Body() updateOrderItemDto: UpdateOrderItemDto) {
  //   return this.orderItemService.update(+id, updateOrderItemDto);
  // }

  // @Delete(':id')
  // remove(@Param('id') id: string) {
  //   return this.orderItemService.remove(+id);
  // }
}
