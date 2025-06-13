import { PartialType } from "@nestjs/swagger";
import { CreateOrderDto } from "src/modules/order/dto/create-order.dto";
import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class UpdateOrderDto extends PartialType(CreateOrderDto) {
    @ApiProperty({ type: Date, required: false, description: "Temps de livraison estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_delivery_time?: string;

    @ApiProperty({ type: Date, required: false, description: "Temps de préparation estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_preparation_time?: string;
}
