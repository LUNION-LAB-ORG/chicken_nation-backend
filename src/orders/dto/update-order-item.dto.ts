import { PartialType } from "@nestjs/swagger/dist";
import { CreateOrderItemDto } from "src/orders/dto/create-order-item.dto";

export class UpdateOrderItemDto extends PartialType(CreateOrderItemDto) { }
