import { IsBoolean, IsNumber, IsString } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ApplyDiscountPromotionDto {
    @ApiProperty({ description: 'ID de la promotion' })
    @IsString()
    promotion_id: string;

    @ApiProperty({ description: 'Montant de la commande' })
    @Transform(({ value }) => Number(value))
    @IsNumber()
    order_amount: number;

    @ApiProperty({ description: 'Liste des plats de la commande' })
    @Transform(({ value }) => JSON.parse(value))
    items: ApplyItemDto[];
}

export class ApplyItemDto {
    @ApiProperty({ description: 'ID du plat' })
    @IsString()
    dish_id: string;

    @ApiProperty({ description: 'Quantité du plat' })
    @Transform(({ value }) => Number(value))
    @IsNumber()
    quantity: number;

    @ApiProperty({ description: 'Prix du plat' })
    @Transform(({ value }) => Number(value))
    @IsNumber()
    price: number;
}

export class ApplyDiscountPromotionDtoResponse {

    @ApiProperty({ description: 'Montant de la remise' })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    discount_amount: number;

    @ApiProperty({ description: 'Montant final de la commande' })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    final_amount: number;

    @ApiProperty({ description: 'Indique si la promotion est applicable' })
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    applicable: boolean;

    @ApiPropertyOptional({ description: 'Motif de non-applicabilité' })
    @IsString()
    reason?: string;
}
