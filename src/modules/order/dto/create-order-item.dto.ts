import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsNumber, IsOptional, IsUUID, Min, ValidateNested } from "class-validator";
import { Transform, Type } from "class-transformer";

/**
 * Supplément avec quantité (nouveau format backoffice, identique au mobile V2).
 * { id: "uuid-du-supplement", quantity: 2 }
 */
export class SupplementItemBackofficeDto {
    @IsUUID()
    id: string;

    @IsNumber()
    @Min(1)
    @Transform(({ value }) => Number(value))
    quantity: number;
}

export class CreateOrderItemDto {
    @ApiProperty({ description: "ID du plat" })
    @IsUUID()
    dish_id: string;

    @ApiProperty({ description: "Quantité commandée", minimum: 1, default: 1 })
    @IsNumber()
    @Min(1)
    @Transform(({ value }) => Number(value))
    quantity: number;

    @ApiPropertyOptional({ description: "IDs des suppléments choisis (ancien format)", type: [String] })
    @IsOptional()
    @IsArray()
    @IsUUID(undefined, { each: true })
    supplements_ids?: string[];

    @ApiPropertyOptional({ description: "Suppléments avec quantité (nouveau format)", type: [SupplementItemBackofficeDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SupplementItemBackofficeDto)
    supplements?: SupplementItemBackofficeDto[];

    @ApiPropertyOptional({ description: "ID de la promotion" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    epice: boolean;
}