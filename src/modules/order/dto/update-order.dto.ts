import { ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { CreateOrderDto } from "src/modules/order/dto/create-order.dto";
import { IsBoolean, IsNumber, IsOptional, IsString } from "class-validator";
import { Type } from "class-transformer";

export class UpdateOrderDto extends PartialType(CreateOrderDto) {
    @ApiPropertyOptional({ type: Date, required: false, description: "Temps de livraison estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_delivery_time?: string;

    @ApiPropertyOptional({ type: Date, required: false, description: "Temps de préparation estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_preparation_time?: string;


    @ApiPropertyOptional({ type: Date, required: false, description: "Date du paiement", example: "2023-01-01T00:00:00.000Z" })
    @IsOptional()
    @IsString()
    paied_at?: string

    @ApiPropertyOptional({ type: Boolean, required: false, description: "Statut du paiement", example: true })
    @IsOptional()
    @IsBoolean()
    @Type(() => Boolean)
    paied?: boolean;

    @ApiPropertyOptional({ type: Number, required: false, description: "Montant de la commande", example: 1500 })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    amount?: number;
}
