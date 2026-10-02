import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { CreateOrderDto } from "src/modules/order/dto/create-order.dto";
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from "class-validator";
import { Transform, Type } from "class-transformer";
import { OrderCreateDto } from "./order-create.dto";
import { OrderStatus } from "@prisma/client";

export class UpdateOrderDto extends PartialType(CreateOrderDto) {
    @ApiPropertyOptional({ type: Date, required: false, description: "Temps de livraison estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_delivery_time?: string;

    @ApiPropertyOptional({ type: Date, required: false, description: "Temps de préparation estimée", example: "1j | 30m | 45m | 2h30m | 60s | 1h" })
    @IsOptional()
    @IsString()
    estimated_preparation_time?: string;


    @ApiPropertyOptional({ type: Date, required: false, description: "Date du paiement (administrateur seulement, ignorée pour les autres comptes)", example: "2023-01-01T00:00:00.000Z" })
    @IsOptional()
    @IsString()
    paied_at?: string

    @ApiPropertyOptional({ type: Boolean, required: false, description: "Statut du paiement (administrateur seulement, ignoré pour les autres comptes)", example: true })
    @IsOptional()
    @IsBoolean()
    @Type(() => Boolean)
    paied?: boolean;

    @ApiPropertyOptional({ type: Number, required: false, description: "Montant de la commande (administrateur seulement, ignoré pour les autres comptes : il se recalcule à partir des articles)", example: 1500 })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    amount?: number;

    /**
     * Retire le code promo ou le bon de la commande : bon recrédité, usage du
     * code rendu, remise retirée du total. Avec `code_promo` dans la même
     * requête, le nouveau coupon remplace l'ancien (une seule transaction).
     * Même droit qu'à la création (COMMANDES CREATE), contrôlé par le service.
     */
    @ApiPropertyOptional({ type: Boolean, required: false, description: "Retirer le code promo ou le bon de la commande (le client le récupère). Avec code_promo : remplacement.", example: true })
    @IsOptional()
    // Jamais `Type(() => Boolean)` : Boolean("false") vaut vrai.
    @Transform(({ value }) =>
        value === undefined || value === null ? value : value === true || String(value).trim().toLowerCase() === 'true',
    )
    @IsBoolean()
    retirer_coupon?: boolean;
}

export class OrderUpdatedDto extends PartialType(OrderCreateDto) {
    @ApiProperty({ description: "Type de commande", enum: OrderStatus })
    @IsEnum(OrderStatus)
    status: OrderStatus;

}
