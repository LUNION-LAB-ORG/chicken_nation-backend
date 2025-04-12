import { PartialType } from "@nestjs/swagger";
import { CreateOrderDto } from "src/modules/orders/dto/create-order.dto";

export class UpdateOrderDto extends PartialType(CreateOrderDto) { }
