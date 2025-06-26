import { IsBoolean, IsNumber, IsString } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ApplyDiscountPromotionDto {
    @ApiProperty({ description: 'ID de la promotion' })
    @IsString()
    promotion_id: string;

    @ApiProperty({ description: 'Montant de la commande' })
    @Type(() => Number)
    @IsNumber()
    order_amount: number;

    @ApiProperty({ description: 'Liste des plats de la commande' })
    @Type(() => ApplyItemDto)
    @Transform(({ value }) => JSON.parse(value))
    items: ApplyItemDto[];
}

export class ApplyItemDto {
    @ApiProperty({ description: 'ID du plat' })
    @IsString()
    dish_id: string;

    @ApiProperty({ description: 'Quantité du plat' })
    @Type(() => Number)
    @IsNumber()
    quantity: number;

    @ApiProperty({ description: 'Prix du plat' })
    @Type(() => Number)
    @IsNumber()
    price: number;
}

export class ApplyDiscountPromotionDtoResponse {

    @ApiProperty({ description: 'Montant de la remise' })
    @Type(() => Number)
    @IsNumber()
    discount_amount: number;

    @ApiProperty({ description: 'Montant final de la commande' })
    @Type(() => Number)
    @IsNumber()
    final_amount: number;

    @ApiProperty({ description: 'Indique si la promotion est applicable' })
    @IsBoolean()
    @Type(() => Boolean)
    applicable: boolean;

    @ApiPropertyOptional({ description: 'Motif de non-applicabilité' })
    @IsString()
    reason?: string;
}
