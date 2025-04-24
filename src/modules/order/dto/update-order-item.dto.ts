import { PickType } from "@nestjs/swagger/dist";
import { CreateOrderItemDto } from "src/modules/order/dto/create-order-item.dto";

export class UpdateOrderItemDto extends PickType(CreateOrderItemDto, ['quantity', 'supplements_ids']) { }
